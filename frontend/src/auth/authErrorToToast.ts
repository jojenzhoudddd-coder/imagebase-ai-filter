/**
 * Map a backend auth error `code` to a toast i18n key. Centralised so both
 * LoginPage and RegisterPage use the same mapping — and when the backend
 * introduces a new code, we only update one place.
 */
export function codeToToastKey(
  code: string | undefined,
  fallback: "auth.toast.networkError" | "auth.toast.serverError" = "auth.toast.serverError",
): string {
  switch (code) {
    case "EMAIL_INVALID":       return "auth.toast.emailInvalid";
    case "EMAIL_TAKEN":         return "auth.toast.emailTaken";
    case "PASSWORD_TOO_SHORT":  return "auth.toast.passwordTooShort";
    case "USERNAME_INVALID":    return "auth.toast.usernameInvalid";
    case "INVALID_CREDENTIALS": return "auth.toast.invalidCredentials";
    case "MISSING_FIELDS":      return "auth.toast.emailRequired";
    default:                    return fallback;
  }
}
