/**
 * Password strength rules.
 *
 * The canonical implementation lives in @eventreach/shared so the backend and
 * the frontend validate identically. Re-exported here to keep backend import
 * paths stable.
 *
 * Applied when a password is *set* (registration, password reset). Deliberately
 * NOT applied at login: accounts created before this policy must still sign in.
 */
export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_REQUIREMENTS,
  validatePassword,
  isPasswordValid,
} from '@eventreach/shared';
