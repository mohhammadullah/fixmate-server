
import { Router } from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import {
  getMyNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "../controllers/notification.controller.js";

const router = Router();

// All notification endpoints are scoped to the authenticated caller's own
// embedded notification array — no cross-user access exists.
router.get("/", verifyToken, getMyNotifications);
router.get("/unread-count", verifyToken, getUnreadCount);
router.patch("/:id/read", verifyToken, markNotificationRead);
router.post("/read-all", verifyToken, markAllNotificationsRead);

export default router;
