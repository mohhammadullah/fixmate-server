# Admin bootstrap (one-time)

Public signup always creates a `customer`. There is deliberately **no public
HTTP endpoint** that can create or promote an admin. To create the first admin,
promote an existing user with a server-side script:

1. Make sure the account exists (sign up normally through the app first).
2. Set two environment variables **only for this one run**:

   ```bash
   ADMIN_BOOTSTRAP_EMAIL=you@example.com
   ADMIN_BOOTSTRAP_CONFIRM=true
   ```

3. Run:

   ```bash
   npm run bootstrap:admin
   ```

4. **Remove both `ADMIN_BOOTSTRAP_*` variables** from your shell / `.env` /
   deployment configuration and restart the server. Leaving them set does not
   grant anything by itself, but they should not linger.

## Safety rules enforced by the script

- Requires both variables; refuses to run without the explicit confirmation.
- Finds the user by **exact email**; refuses if no user exists or if the email
  matches more than one user.
- Never creates a user and never accepts a password.
- Refuses to run if the target is already an admin or is not a `customer`.
- Uses an atomic `role: "customer" → "admin"` update and refuses on a race.

Store no secrets in the repository — the variables are provided at runtime.
