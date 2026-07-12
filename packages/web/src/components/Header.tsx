import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useApp, useSession } from "../app-context.tsx";
import { DevAuthProvider, GoogleAuthProvider } from "../lib/auth.ts";
import {
  applyThemePreference,
  getThemePreference,
  nextPreference,
  systemPrefersDark,
  watchSystemTheme,
} from "../lib/theme.ts";
import type { ThemePreference } from "../lib/theme.ts";
import { Button } from "./Button.tsx";
import { GoogleSignInButton } from "./GoogleSignInButton.tsx";
import { BrandMark, Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";
import { SearchInput } from "./SearchInput.tsx";

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { auth } = useApp();
  const session = useSession();
  const googleAuth = auth instanceof GoogleAuthProvider ? auth : null;

  // Close once the GIS flow (or dev login) lands a session.
  useEffect(() => {
    if (open && session) onClose();
  }, [open, session, onClose]);

  if (googleAuth) {
    return (
      <Modal
        open={open}
        title="ログイン / 新規登録"
        onClose={onClose}
        footer={
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
        }
      >
        <p>
          Google アカウントでログインしてください。
          <br />
          初めての方も、そのままアカウントが作成されます。
        </p>
        {open && <GoogleSignInButton auth={googleAuth} />}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title="ログインが必要です"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            onClick={() => {
              try {
                void auth.login();
              } finally {
                onClose();
              }
            }}
          >
            Google でログイン
          </Button>
        </>
      }
    >
      <p>レポートのアップロードには Google アカウントでのログインが必要です</p>
    </Modal>
  );
}

export function Header() {
  const { auth } = useApp();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [themePref, setThemePref] = useState<ThemePreference>(() => getThemePreference());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const q = location.pathname === "/search" ? (params.get("q") ?? "") : "";

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // system 追従中の OS テーマ変化を即時反映（CSS はメディアクエリで追従、ラベル表示を同期）
  useEffect(() => watchSystemTheme(setSystemDark), []);

  const cycleTheme = () => {
    const next = nextPreference(themePref);
    setThemePref(next);
    applyThemePreference(next);
  };

  const themeLabel =
    themePref === "system"
      ? `テーマ: システム設定に追従（現在: ${systemDark ? "ダーク" : "ライト"}）`
      : themePref === "light"
        ? "テーマ: ライト"
        : "テーマ: ダーク";

  const devAuth = auth instanceof DevAuthProvider ? auth : null;

  return (
    <header className="hrb-header">
      <div className="hrb-header__inner">
        <Link to="/" className="hrb-header__logo">
          <BrandMark size={28} />
          HTML Report Box
        </Link>

        <div className="hrb-header__search">
          <SearchInput
            initialValue={q}
            onSearch={(query) => navigate(`/search?q=${encodeURIComponent(query)}`)}
          />
        </div>

        <div className="hrb-header__actions">
          <Button
            onClick={() => {
              if (session) navigate("/upload");
              else setLoginOpen(true);
            }}
          >
            <Icon name="upload" size={16} />
            アップロード
          </Button>

          <button
            type="button"
            className="hrb-icon-btn"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={cycleTheme}
          >
            <Icon
              name={themePref === "system" ? "monitor" : themePref === "light" ? "sun" : "moon"}
              size={18}
            />
          </button>

          {session ? (
            <div className="hrb-usermenu" ref={menuRef}>
              <button
                type="button"
                className="hrb-usermenu__trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span className="hrb-avatar" aria-hidden="true">
                  {session.picture ? (
                    <img src={session.picture} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    session.name.slice(0, 1).toUpperCase()
                  )}
                </span>
                <span className="hrb-usermenu__name">{session.name}</span>
                <span className="hrb-usermenu__caret" aria-hidden="true">
                  <Icon name="chevron-down" size={14} />
                </span>
              </button>
              {menuOpen && (
                <div className="hrb-usermenu__dropdown" role="menu">
                  {session.email && (
                    <div className="hrb-usermenu__identity">
                      <div className="hrb-usermenu__identity-name">{session.name}</div>
                      <div className="hrb-usermenu__identity-email">{session.email}</div>
                      <hr className="hrb-usermenu__divider" />
                    </div>
                  )}
                  {devAuth && (
                    <div className="hrb-usermenu__section">
                      <div className="hrb-usermenu__section-title">devユーザー切替</div>
                      {devAuth.users.map((u) => (
                        <label key={u} className="hrb-usermenu__radio">
                          <input
                            type="radio"
                            name="dev-user"
                            checked={session.name === u}
                            onChange={() => devAuth.setUser(u)}
                          />
                          {u}
                        </label>
                      ))}
                      <hr className="hrb-usermenu__divider" />
                    </div>
                  )}
                  <button
                    type="button"
                    className="hrb-usermenu__item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate("/mine");
                    }}
                  >
                    マイレポート
                  </button>
                  {session.isAdmin && (
                    <button
                      type="button"
                      className="hrb-usermenu__item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        navigate("/admin");
                      }}
                    >
                      管理画面
                    </button>
                  )}
                  <button
                    type="button"
                    className="hrb-usermenu__item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      auth.logout();
                    }}
                  >
                    ログアウト
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setLoginOpen(true)}>
              Google でログイン
            </Button>
          )}
        </div>
      </div>

      <div className="hrb-header__search hrb-header__search--mobile">
        <SearchInput
          initialValue={q}
          onSearch={(query) => navigate(`/search?q=${encodeURIComponent(query)}`)}
        />
      </div>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </header>
  );
}
