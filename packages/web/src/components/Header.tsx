import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useApp, useSession } from "../app-context.tsx";
import { DevAuthProvider } from "../lib/auth.ts";
import { applyTheme, getEffectiveTheme, nextTheme } from "../lib/theme.ts";
import type { Theme } from "../lib/theme.ts";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";
import { SearchInput } from "./SearchInput.tsx";

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { auth } = useApp();
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
  const [theme, setTheme] = useState<Theme>(() => getEffectiveTheme());
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

  const toggleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
  };

  const devAuth = auth instanceof DevAuthProvider ? auth : null;

  return (
    <header className="hrb-header">
      <div className="hrb-header__inner">
        <Link to="/" className="hrb-header__logo">
          <span aria-hidden="true">📦</span> HTML Report Box
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
            + アップロード
          </Button>

          <button
            type="button"
            className="hrb-icon-btn"
            aria-label="テーマ切り替え"
            onClick={toggleTheme}
          >
            {theme === "light" ? "🌙" : "☀️"}
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
                  {session.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="hrb-usermenu__name">{session.name}</span>
              </button>
              {menuOpen && (
                <div className="hrb-usermenu__dropdown" role="menu">
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
