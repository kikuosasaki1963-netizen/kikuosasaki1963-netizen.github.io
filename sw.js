/*
 * Service Worker の実体（F-06 オフライン動作・要件定義 §4-1）。
 *
 * 🚨 cache-first。⛔ 電車内で「読み込み中…」を出さない（要件定義 §5「通信待ちのブロッキングUIを出さない」）。
 * 🚨 プリキャッシュ対象と版は隣の `sw-precache.js` から読む。
 *   これは **vite のビルド時に実物のバンドル名から生成される**
 *   （frontend/vite.config.ts の precacheManifest プラグイン）。
 *   ⛔ ここにファイル名を手で書かない（ハッシュ付き名は毎ビルド変わる＝必ず腐る）。
 *   ⛔ 読めなければ install ごと失敗させる。中途半端に動く SW は、無い SW より悪い。
 *
 * 🚨 ⛔ パスを絶対パス（`/…`）で書かない。この SW は `https://<user>.github.io/<repo>/` のような
 *   **サブパスの下に置かれる**ことがある（HANDOFF 仕事1）。絶対パスは配信先のルートを指してしまい、
 *   `/sw-precache.js` は 404、`/` は**別リポの画面**になる。
 *   ⇒ 自分の置かれた場所（`self.location`）からの相対で解く。**ベースパスをここに書かない**
 *     ＝ 配信先が変わってもこのファイルは1文字も変わらない。
 *
 * ⛔ 失敗を隠さない: キャッシュにも無く通信も無ければ、そのまま失敗させる。
 *   偽の「空の応答」を返すと、画面は壊れているのに壊れていないふりをする。
 */

importScripts('./sw-precache.js')

const CACHE_NAME = `chinkanshi-offline-${self.__PRECACHE_VERSION__}`
const PRECACHE_URLS = self.__PRECACHE_URLS__

/**
 * 画面の入口。SPA なのでどのパスへ来ても入口を返す。
 * 🚨 `index.html` ではなく**ベースパスそのもの**。⛔ プリキャッシュ一覧に載っている URL 以外を入口にしない
 *   （一覧はビルド結果から起こしており、index.html は自分の名前では載らない。
 *    `index.html` を入口にすると、圏外で入口だけキャッシュに無い＝真っ白になる）。
 * 🚨 ベースパスは `self.location` から導く。sw.js は必ず配信ルート直下（`<base>sw.js`）に置かれるので、
 *   そこからの `./` が `<base>` そのものだ。⛔ 値を埋め込まない（vite の `base` と二重管理になる）。
 */
const APP_SHELL_URL = new URL('./', self.location.href).pathname

/*
 * 🚨 **プリキャッシュに実体が在る URL の一覧**（パスだけ）。
 *
 * 🔬 なぜ要るか（2026-08-23 実測・⛔ 推測ではない）:
 *    下の `navigate` の分岐は「どのパスへ来ても入口を返す」だった。⇒ SPA のルートはそれでよいが、
 *    **`privacy.html` のような“アプリではない実体”まで入口で上書きしてしまう。**
 *    実測: SW を入れた状態で `/privacy.html` を開くと、アプリの入口が描かれ
 *    ルータが URL を拾えず **「ページが見つからない」** になった。
 *    ⇒ **プライバシーポリシーが、SW の入っている端末でだけ読めない**という状態だった
 *      （Apple 5.1.1(i) は "within the app in an easily accessible manner" を求める）。
 *
 * ⛔ ここに固有のファイル名を書かない。⇒ 一覧は `sw-precache.js`（ビルド生成）が正本で、
 *    **`public/` に実体を1つ置けば自動で載る**。⛔ 次にページを足した人が同じ穴を踏まない。
 */
const PRECACHE_PATHS = new Set(PRECACHE_URLS)

/**
 * その navigate が「実体を返すべき URL」なら、その実体の URL を返す。⛔ 違えば `null`。
 *
 * 🚨 拡張子なし（`/privacy`）も見る。静的ホスト（GitHub Pages）は拡張子なし URL を `.html` に
 *    解決する（🔬 2026-08-23 実測: `/index` 200・`/404` 200・`/manifest` 404）。
 *    ⇒ ここで見ないと、**同じ URL が「SW が入っている端末」と「入っていない端末」で違う中身を返す**。
 *    ⛔ その食い違いを出荷しない。
 */
function precachedEntryFor(pathname) {
  if (PRECACHE_PATHS.has(pathname)) {
    return pathname
  }
  const asHtml = `${pathname}.html`
  return PRECACHE_PATHS.has(asHtml) ? asHtml : null
}

/*
 * 🚨 **自分のスクリプトはキャッシュに入れない**（この SW 自身と、その一覧）。⛔ 外すな。
 *
 * 理由: 画面側（src/features/offline/swVersion.ts）は「いま配られている版」を
 *   `sw-precache.js` を直に読んで知る。**これがキャッシュを1つも通らない唯一の経路**だ。
 *   ⇒ ここで cache-first に掛けると、一度掴んだ一覧が固まって
 *     **画面が永久に古い版を名乗り続ける**＝ いま直している欠陥がそのまま再発する。
 * 🚨 `sw.js` も同じ理由で外す。ブラウザは自分の道で取りに来るが、
 *   ⛔ 画面から引かれたときに焼き込むと、古い SW が居座る種になる。
 * ⛔ ここでベースパスを書かない（`self.location` からの相対で解く＝配信先が変わっても腐らない）。
 */
const OWN_SCRIPT_PATHS = new Set(
  ['./sw.js', './sw-precache.js'].map((path) => new URL(path, self.location.href).pathname),
)

self.addEventListener('install', (event) => {
  /*
   * 🚨 install で全部揃える。⇒ 一度オンラインで開けば、次からは圏外でも起動する。
   *
   * 🚨 揃え**終えてから** `skipWaiting()` で待機列を降りる。⛔ 先に呼ばない
   *   （プリキャッシュが揃う前に制御を取ると、圏外で欠けた資産を掴む＝真っ白になる）。
   *   `addAll` は1つでも落ちれば拒否されるので、ここに来た時点で一式が揃っている。
   *
   * 🚨 ⛔ この `skipWaiting()` を「無条件は危ない」と外すな。**外すと新版が永久に届かない。**
   *   実測（2026-08-22 本番）: 旧 SW が `active` のまま、新版が `waiting` で止まり続けた。
   *   `activate` は**全クライアントが閉じるまで起きない**ので、ホーム画面から使う PWA では事実上永久に来ない。
   *   ⇒ 「ページから合図を送ってもらってから降りる」形は**この状況を救えない**。
   *     いま端末で動いている**旧版のページには合図を送るコードが無い**（新版にしか入らない）からだ。
   *     待機列を降りられるのは**新しい SW 自身**だけ ＝ ここで無条件に呼ぶしか出口が無い。
   *
   * 🚨 ⛔ ここで交代しても**開いている画面の進行は飛ばない**。skipWaiting が変えるのは
   *   「**これから先の fetch に誰が答えるか**」だけで、開いているページを読み直させはしない。
   *   このアプリは動的 import を持たない単一バンドル（`index-*.js` / `index-*.css` は読み込み済み）なので、
   *   解答中のページは以後**資産を1本も取りに行かない**。
   *   ⇒ 進行が飛ぶのは**読み直した瞬間だけ**。だから読み直す判断は画面側に置く
   *     （src/features/offline/appUpdate.ts ＝ セッションを抱えている間は読み直させない）。
   */
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // 古い版のキャッシュを消す。⛔ 溜め続けない（端末の容量はユーザーのものだ）。
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)

  /*
   * 🚨 `ignoreVary: true` は**実測で踏んだ地雷**への対処だ。⛔ 既定に戻すな。
   *   静的配信（vite preview / 多くの CDN）は `Vary: Origin` を付ける。
   *   既定の match は Vary に挙がったヘッダまで突き合わせるので、
   *   **キャッシュに在るのに外す** → 圏外でアプリが真っ白になる。
   *   ここは自分で入れた同一オリジンの実体しか置いていない ＝ Vary を見る意味が無い。
   */
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) {
    return cached
  }
  const response = await fetch(request)
  // basic ＝ 同一オリジンの実体。opaque な応答をキャッシュに混ぜない。
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request

  // ⛔ 解答ログの送信（POST）に触らない。同期の成否は syncQueue.ts だけが判断する。
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  // ⛔ 他オリジン（backend API など）をキャッシュしない。古い応答を掴ませない。
  if (url.origin !== self.location.origin) {
    return
  }
  // 🚨 自分のスクリプトは素通し（上の OWN_SCRIPT_PATHS を読め）。⛔ 一覧を固めない。
  if (OWN_SCRIPT_PATHS.has(url.pathname)) {
    return
  }
  if (request.mode === 'navigate') {
    // 🚨 実体が在るならその実体を返す（⛔ 入口で上書きしない）。無ければ SPA なので入口を返す。
    const entry = precachedEntryFor(url.pathname)
    event.respondWith(cacheFirst(new Request(entry === null ? APP_SHELL_URL : entry)))
    return
  }
  event.respondWith(cacheFirst(request))
})
