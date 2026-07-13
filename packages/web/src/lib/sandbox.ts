/**
 * アップロードされた HTML を埋め込む iframe に共通で付ける sandbox 属性。
 * 公開コンテンツ（別オリジン）・非公開プレビュー（srcdoc）・バージョン
 * プレビュー（srcdoc）で必ず同じ値を使うこと。allow-same-origin は付けない。
 */
export const IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";
