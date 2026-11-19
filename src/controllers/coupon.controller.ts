
import type { Response } from "express";
import { ObjectId, type Document } from "mongodb";
import type { AuthenticatedRequest } from "../middleware/verifyToken.js";
import {
  applyCouponSchema,
  upsertCouponSchema,
  updateCouponSchema,
  couponIdParamSchema,
} from "../validators/features.validator.js";
import {
  getUsersCollection,
  USERS_COLLECTION,
} from "../models/technician-application.model.js";
import { getBookingsCollection } from "../models/booking.model.js";
import { getDB } from "../config/db.js";
import {
  MAX_COUPONS,
  type CouponDefinition,
  type AdminConfig,
} from "../models/user-config.model.js";
import {
  canonicalizeCategory,
  type ServiceCategory,
} from "../models/service.model.js";
import { getPaymentsCollection } from "../models/payment.model.js";
import { stripeCurrency } from "../config/stripe.js";
import { isObjectIdHex } from "../utils/objectid.js";

// Coupon definitions are platform configuration embedded on the single Main
// Admin user document (`adminConfig.coupons`). They are bounded (≤200),
// editable only by the designated Main Admin, and transferred atomically
// with the Main Admin role.

const CODE_RE = /^[A-Z0-9_\-]+$/;

export const normalizeCouponCode = (raw: string): string =>
  raw.trim().toUpperCase();

/** Locate the Main Admin (isMainAdmin=true) user document. */
const findMainAdmin = () =>
  getUsersCollection().findOne(
    { isMainAdmin: true },
    { projection: { adminConfig: 1 } }
  );

const loadAdminConfig = async (): Promise<AdminConfig> => {
  const mainAdmin = await findMainAdmin();
  const raw = mainAdmin?.adminConfig as AdminConfig | undefined;
  return { coupons: Array.isArray(raw?.coupons) ? raw!.coupons : [] };
};

const toPublicCoupon = (coupon: CouponDefinition) => ({
  code: coupon.code,
  kind: coupon.kind,
  value: coupon.value,
  currency: coupon.currency,
  minBookingAmount: coupon.minBookingAmount,
  maxDiscount: coupon.maxDiscount,
  startsAt: coupon.startsAt,
  expiresAt: coupon.expiresAt,
  globalLimit: coupon.globalLimit,
  perCustomerLimit: coupon.perCustomerLimit,
  categories: coupon.categories,
  active: coupon.active,
  usageCount: coupon.usageCount,
});

const toCouponPreview = (
  coupon: CouponDefinition,
  amount: number, // major units
  currency: string
): { discount: number; total: number } | null => {
  if (amount < coupon.minBookingAmount) return null;
  let discount =
    coupon.kind === "percent"
      ? Math.round(((amount * coupon.value) / 100) * 100) / 100
      : coupon.value;
  if (coupon.maxDiscount !== undefined) {
    discount = Math.min(discount, coupon.maxDiscount);
  }
  discount = Math.min(discount, amount);
  if (discount <= 0) return null;
  const total = Math.round((amount - discount) * 100) / 100;
  return { discount: Math.round(discount * 100) / 100, total };
};

const customerRedemptions = async (
  customerId: ObjectId,
  code: string
): Promise<number> => {
  // Count only settled redemptions for the per-customer limit.
  return getPaymentsCollection().countDocuments({
    customerId,
    status: "succeeded",
    "appliedCoupon.code": code,
  });
};

/**
 * Validate a coupon against an amount. Returns either an error message or
 * the computed discount. Fresh reads only — never trust cached adminConfig.
 */
export const validateCouponForAmount = async (
  code: string,
  amount: number,
  currency: string,
  customerId: ObjectId,
  serviceCategory?: ServiceCategory
): Promise<
  | { ok: true; coupon: CouponDefinition; discount: number; total: number }
  | { ok: false; message: string }
> => {
  const normalized = normalizeCouponCode(code);
  if (!CODE_RE.test(normalized)) {
    return { ok: false, message: "Invalid coupon code format." };
  }

  const config = await loadAdminConfig();
  const coupon = config.coupons.find((entry) => entry.code === normalized);
  if (!coupon) {
    return { ok: false, message: "Coupon code not found." };
  }
  if (!coupon.active) {
    return { ok: false, message: "This coupon is disabled." };
  }

  const now = Date.now();
  if (new Date(coupon.startsAt).getTime() > now) {
    return { ok: false, message: "This coupon is not active yet." };
  }
  if (new Date(coupon.expiresAt).getTime() < now) {
    return { ok: false, message: "This coupon has expired." };
  }

  if (coupon.kind === "fixed" && coupon.currency && coupon.currency !== currency) {
    return {
      ok: false,
      message: `This coupon applies only to ${coupon.currency.toUpperCase()} payments.`,
    };
  }

  if (coupon.categories && coupon.categories.length > 0 && serviceCategory) {
    if (!coupon.categories.includes(serviceCategory)) {
      return { ok: false, message: "This coupon is not valid for this service category." };
    }
  }

  const preview = toCouponPreview(coupon, amount, currency);
  if (!preview) {
    return {
      ok: false,
      message: coupon.minBookingAmount > 0
        ? `A minimum of ${coupon.minBookingAmount} ${currency.toUpperCase()} is required for this coupon.`
        : "This coupon cannot be applied to this amount.",
    };
  }

  if (coupon.globalLimit !== undefined && coupon.usageCount >= coupon.globalLimit) {
    return { ok: false, message: "This coupon has reached its usage limit." };
  }

  const redemptions = await customerRedemptions(customerId, coupon.code);
  if (redemptions >= coupon.perCustomerLimit) {
    return { ok: false, message: "You have already used this coupon." };
  }

  return {
    ok: true,
    coupon,
    discount: preview.discount,
    total: preview.total,
  };
};

/**
 * Atomically validate + claim a coupon redemption inside a MongoDB
 * transaction (same pattern as transferMainAdmin). Reads the Main Admin's
 * adminConfig, re-validates everything server-side, and increments
 * usageCount iff a global-limit slot is available. Returns the validated
 * discount, or an error. The per-customer limit is enforced from settled
 * redemptions (global counter stays the authoritative usage figure).
 */
export const claimCouponRedemption = async (
  code: string,
  amount: number,
  currency: string,
  customerId: ObjectId,
  serviceCategory?: ServiceCategory
): Promise<
  | { ok: true; coupon: CouponDefinition; discount: number; total: number }
  | { ok: false; message: string }
> => {
  const normalized = normalizeCouponCode(code);
  if (!CODE_RE.test(normalized)) {
    return { ok: false, message: "Invalid coupon code format." };
  }

  const client = getDB().client;
  const session = client.startSession();
  try {
    let result: Awaited<ReturnType<typeof validateCouponForAmount>> | undefined;

    await session.withTransaction(async () => {
      const mainAdmin = await getUsersCollection().findOne(
        { isMainAdmin: true },
        { projection: { adminConfig: 1 }, session }
      );
      if (!mainAdmin) {
        result = { ok: false, message: "No coupon configuration is available." };
        return;
      }
      const coupons = (((mainAdmin as { adminConfig?: AdminConfig }).adminConfig?.coupons) ?? []) as CouponDefinition[];
      const coupon = coupons.find(
        (entry) => entry.code === normalized && entry.active
      );
      if (!coupon) {
        result = { ok: false, message: "Coupon code not found or disabled." };
        return;
      }
      const now = Date.now();
      if (new Date(coupon.startsAt).getTime() > now) {
        result = { ok: false, message: "This coupon is not active yet." };
        return;
      }
      if (new Date(coupon.expiresAt).getTime() < now) {
        result = { ok: false, message: "This coupon has expired." };
        return;
      }
      if (coupon.kind === "fixed" && coupon.currency && coupon.currency !== currency) {
        result = { ok: false, message: `This coupon applies only to ${coupon.currency.toUpperCase()} payments.` };
        return;
      }
      if (coupon.categories && coupon.categories.length > 0 && serviceCategory && !coupon.categories.includes(serviceCategory)) {
        result = { ok: false, message: "This coupon is not valid for this service category." };
        return;
      }
      const preview = toCouponPreview(coupon, amount, currency);
      if (!preview) {
        result = {
          ok: false,
          message: coupon.minBookingAmount > 0
            ? `A minimum of ${coupon.minBookingAmount} ${currency.toUpperCase()} is required for this coupon.`
            : "This coupon cannot be applied to this amount.",
        };
        return;
      }
      if (coupon.globalLimit !== undefined && coupon.usageCount >= coupon.globalLimit) {
        result = { ok: false, message: "This coupon has reached its usage limit." };
        return;
      }

      // Per-customer check (settled redemptions) — document-level read
      // within the transaction; global counter is also bumped below.
      const redemptions = await getPaymentsCollection().countDocuments(
        { customerId, status: "succeeded", "appliedCoupon.code": normalized },
        { session }
      );      if (redemptions >= coupon.perCustomerLimit) {
        result = { ok: false, message: "You have already used this coupon." };
        return;
      }

      // Claim the slot atomically within the transaction.
      const updatedCoupons = coupons.map((entry) =>
        entry.code === normalized
          ? { ...entry, usageCount: entry.usageCount + 1 }
          : entry
      );
      await getUsersCollection().updateOne(
        { _id: mainAdmin._id },
        { $set: { "adminConfig.coupons": updatedCoupons, "adminConfig.updatedAt": new Date() } },
        { session }
      );

      result = {
        ok: true,
        coupon: { ...coupon, usageCount: coupon.usageCount + 1 },
        discount: preview.discount,
        total: preview.total,
      };
    });

    return result ?? { ok: false, message: "Coupon validation failed." };
  } catch (error) {
    console.error("Coupon claim transaction failed:", error);
    return { ok: false, message: "Coupon validation is temporarily unavailable." };
  } finally {
    await session.endSession();
  }
};

/**
 * Roll back one claimed slot — used when checkout creation fails after a
 * successful claim. Never lets the counter go below zero.
 */
export const releaseCouponUsageSlot = async (code: string): Promise<void> => {
  const normalized = normalizeCouponCode(code);
  if (!CODE_RE.test(normalized)) return;

  await getUsersCollection().updateOne(
    {
      isMainAdmin: true,
      "adminConfig.coupons": {
        $elemMatch: { code: normalized, usageCount: { $gt: 0 } },
      },
    },
    {
      $inc: { "adminConfig.coupons.$.usageCount": -1 },
      $set: { "adminConfig.updatedAt": new Date() },
    } as Document
  );
};

// ------------------------------- Admin CRUD ------------------------------
// Read: any admin. Write: Main Admin only (config travels with the
// hierarchy; regular admins must not edit platform configuration).

export const listCoupons = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  const config = await loadAdminConfig();
  const coupons = [...config.coupons].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.status(200).json({
    success: true,
    data: coupons.map(toPublicCoupon),
    isMainAdmin: await isCallerMainAdmin(req.user.id),
  });
};

const isCallerMainAdmin = async (userId: string): Promise<boolean> => {
  if (!isObjectIdHex(userId)) return false;
  const doc = await getDB()
    .collection(USERS_COLLECTION)
    .findOne({ _id: new ObjectId(userId) }, { projection: { isMainAdmin: 1 } });
  return Boolean(doc && (doc as { isMainAdmin?: unknown }).isMainAdmin === true);
};

export const createCoupon = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  if (!(await isCallerMainAdmin(req.user.id))) {
    res.status(403).json({
      success: false,
      message: "Only the Main Admin can create coupons.",
    });
    return;
  }

  const parsed = upsertCouponSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const config = await loadAdminConfig();
  if (config.coupons.some((entry) => entry.code === parsed.data.code)) {
    res.status(409).json({ success: false, message: "A coupon with this code already exists." });
    return;
  }
  if (config.coupons.length >= MAX_COUPONS) {
    res.status(409).json({ success: false, message: `At most ${MAX_COUPONS} coupons are supported.` });
    return;
  }

  const now = new Date();
  const coupon: CouponDefinition = {
    code: parsed.data.code,
    kind: parsed.data.kind,
    value: parsed.data.value,
    ...(parsed.data.currency ? { currency: parsed.data.currency } : {}),
    minBookingAmount: parsed.data.minBookingAmount,
    ...(parsed.data.maxDiscount !== undefined ? { maxDiscount: parsed.data.maxDiscount } : {}),
    startsAt: parsed.data.startsAt,
    expiresAt: parsed.data.expiresAt,
    ...(parsed.data.globalLimit !== undefined ? { globalLimit: parsed.data.globalLimit } : {}),
    perCustomerLimit: parsed.data.perCustomerLimit,
    ...(parsed.data.categories ? { categories: parsed.data.categories } : {}),
    active: parsed.data.active,
    usageCount: 0,
    createdAt: now,
    createdBy: new ObjectId(req.user.id),
  };

  const mainAdmin = await findMainAdmin();
  if (!mainAdmin) {
    res.status(503).json({ success: false, message: "No Main Admin is designated." });
    return;
  }

  const result = await getUsersCollection().updateOne(
    { _id: mainAdmin._id, "adminConfig.coupons": { $not: { $elemMatch: { code: coupon.code } } } },
    {
      $push: { "adminConfig.coupons": coupon },
      $set: { "adminConfig.updatedAt": now },
    } as Document
  );
  if (result.modifiedCount === 0) {
    res.status(409).json({ success: false, message: "A coupon with this code already exists." });
    return;
  }

  res.status(201).json({
    success: true,
    message: "Coupon created.",
    data: toPublicCoupon(coupon),
  });
};

export const updateCoupon = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  if (!(await isCallerMainAdmin(req.user.id))) {
    res.status(403).json({
      success: false,
      message: "Only the Main Admin can edit coupons.",
    });
    return;
  }

  const rawCode = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const parsedCode = couponIdParamSchema.safeParse(rawCode);
  if (!parsedCode.success) {
    res.status(400).json({ success: false, message: "Invalid coupon code." });
    return;
  }

  const parsed = updateCouponSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const config = await loadAdminConfig();
  const current = config.coupons.find((entry) => entry.code === parsedCode.data);
  if (!current) {
    res.status(404).json({ success: false, message: "Coupon not found." });
    return;
  }

  // Only allow safe edits — identity fields stay immutable to keep redemption
  // accounting consistent. globalLimit may be set to a number or removed with
  // explicit `null`.
  const updates = parsed.data;
  if (updates.expiresAt) {
    const startsAt = new Date(current.startsAt);
    if (updates.expiresAt.getTime() <= startsAt.getTime()) {
      res.status(400).json({
        success: false,
        message: "expiresAt must be after startsAt.",
        errors: [{ field: "expiresAt", message: "expiresAt must be after startsAt." }],
      });
      return;
    }
  }

  const mainAdmin = await findMainAdmin();
  if (!mainAdmin) {
    res.status(503).json({ success: false, message: "No Main Admin is designated." });
    return;
  }

  const {
    globalLimit: _ignored,
    ...rest
  } = current;
  void _ignored;
  const merged: CouponDefinition = { ...rest };

  if (updates.active !== undefined) merged.active = updates.active;
  if (updates.expiresAt !== undefined) merged.expiresAt = updates.expiresAt;
  if (updates.perCustomerLimit !== undefined) {
    merged.perCustomerLimit = updates.perCustomerLimit;
  }
  if (updates.globalLimit === null) {
    delete (merged as Partial<CouponDefinition>).globalLimit;
  } else if (typeof updates.globalLimit === "number") {
    merged.globalLimit = updates.globalLimit;
  } else if (current.globalLimit !== undefined) {
    merged.globalLimit = current.globalLimit;
  }

  const updatedCoupons = config.coupons.map((entry) =>
    entry.code === merged.code ? merged : entry
  );
  const result = await getUsersCollection().updateOne(
    { _id: mainAdmin._id, "adminConfig.coupons.code": merged.code },
    { $set: { "adminConfig.coupons": updatedCoupons, "adminConfig.updatedAt": new Date() } }
  );
  if (result.modifiedCount === 0 && result.matchedCount === 0) {
    res.status(503).json({ success: false, message: "Coupon configuration could not be saved." });
    return;
  }

  res.status(200).json({
    success: true,
    message: "Coupon updated.",
    data: toPublicCoupon(merged),
  });
};

export const disableCoupon = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }
  if (!(await isCallerMainAdmin(req.user.id))) {
    res.status(403).json({
      success: false,
      message: "Only the Main Admin can disable coupons.",
    });
    return;
  }

  const rawCode = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const parsedCode = couponIdParamSchema.safeParse(rawCode);
  if (!parsedCode.success) {
    res.status(400).json({ success: false, message: "Invalid coupon code." });
    return;
  }

  const mainAdmin = await findMainAdmin();
  if (!mainAdmin) {
    res.status(503).json({ success: false, message: "No Main Admin is designated." });
    return;
  }

  const result = await getUsersCollection().updateOne(
    { _id: mainAdmin._id, "adminConfig.coupons": { $elemMatch: { code: parsedCode.data } } },
    { $set: { "adminConfig.coupons.$.active": false, "adminConfig.updatedAt": new Date() } }
  );
  if (result.matchedCount === 0) {
    res.status(404).json({ success: false, message: "Coupon not found." });
    return;
  }

  res.status(200).json({ success: true, message: "Coupon disabled." });
};

// ------------------------- Customer: preview discount -------------------------
// POST /api/coupons/validate — customer only; computes the discount for the
// *current* payable amount. Never trust this for charging — the checkout
// session re-validates and re-computes server-side.
export const previewCoupon = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const authUser = req.user;
  if (!authUser || !isObjectIdHex(authUser.id)) {
    res.status(401).json({ success: false, message: "Authentication token is required." });
    return;
  }

  const parsed = applyCouponSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Validation failed.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const booking = await getBookingsCollection().findOne({
    _id: new ObjectId(parsed.data.bookingId),
    customerId: new ObjectId(authUser.id),
  });
  if (!booking) {
    res.status(404).json({ success: false, message: "Booking not found." });
    return;
  }
  if (booking.status !== "completed" || typeof booking.finalAmount !== "number" || !(booking.finalAmount > 0)) {
    res.status(409).json({
      success: false,
      message: "Coupons can only be applied to completed bookings awaiting payment.",
    });
    return;
  }
  if (booking.paymentStatus !== "unpaid") {
    res.status(409).json({ success: false, message: "This booking has already been paid." });
    return;
  }

  const currency =
    (await getDB()
      .collection("payments")
      .findOne({ bookingId: booking._id }, { projection: { currency: 1 } }))?.currency
    ?? stripeCurrency;

  const result = await validateCouponForAmount(
    parsed.data.code,
    booking.finalAmount,
    currency,
    new ObjectId(authUser.id),
    canonicalizeCategory(booking.serviceCategory) ??
      (booking.serviceCategory as ServiceCategory)
  );

  if (!result.ok) {
    res.status(400).json({ success: false, message: result.message });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      code: result.coupon.code,
      kind: result.coupon.kind,
      value: result.coupon.value,
      currency,
      serviceAmount: booking.finalAmount,
      discountAmount: result.discount,
      totalAmount: result.total,
    },
  });
};

export { toPublicCoupon };
export type { CouponDefinition };
