/**
 * Official GIS "Sign in with Google" button. Login and signup are the same
 * flow — first login provisions the account server-side.
 */
import { useEffect, useRef, useState } from "react";
import type { GoogleAuthProvider } from "../lib/auth.ts";

export function GoogleSignInButton({
  auth,
  text,
}: {
  auth: GoogleAuthProvider;
  text?: "signin_with" | "signup_with";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => auth.onLoginError(setError), [auth]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    auth.renderButton(el, text ? { text } : undefined).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : "Google ボタンを表示できませんでした");
    });
    return () => {
      cancelled = true;
    };
  }, [auth, text]);

  return (
    <div className="hrb-google-signin">
      <div ref={ref} className="hrb-google-signin__button" />
      {error && (
        <p className="hrb-google-signin__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
