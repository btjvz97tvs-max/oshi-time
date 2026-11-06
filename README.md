# 推しタイム

にじさんじの推しの「いま配信中」「配信予定」「新着」と、チケットやグッズの締切をひとつにまとめる非公式ファンアプリです。
GitHub Pages で動かし、iPhone のホーム画面に追加して使います。

## できること

- **推しを探す**：にじさんじ全員から名前で検索して推し登録（ひらがな・カタカナ・英語・漢字どれでもOK）
- **ホーム**：推しの配信中・3日先までの配信予定・新着動画。「にじさんじ全員」に切り替えも可能
- **締切**：申込期限などを登録すると、3日前からホームの「今日やること」に表示。iPhoneのカレンダーにも追加できる（前日と3時間前に通知）

にじさんじ全員（ID・KR出身、NIJISANJI EN を含む200人、2026年11月時点）の名簿を `livers.json` に入れてあるので、推しの検索と登録は設定なしですぐ使えます。
配信データは15分ごとに GitHub Actions が [Holodex](https://holodex.net) から自動で集めます。名簿にいない新人も、Holodex に載れば自動で検索に出てきます。
推し登録と締切はその端末の中だけに保存されます。

## はじめかた

1. **Holodex の APIキーを取る**
   holodex.net にログイン → 右上のメニューから Account Settings → API Key を発行してコピー
2. **GitHub にリポジトリを作る**（Public）
   このフォルダの中身をすべて入れる（`.github` フォルダも忘れずに）
3. **APIキーを登録**
   リポジトリの Settings → Secrets and variables → Actions → New repository secret
   名前：`HOLODEX_API_KEY`　値：1でコピーしたキー
4. **Pages を有効にする**
   Settings → Pages → Build and deployment の Source を「GitHub Actions」にする
5. **初回の更新を動かす**
   Actions タブ →「推しデータを更新して公開」→ Run workflow
6. 終わったら表示されるURL（`https://ユーザー名.github.io/リポジトリ名/`）を iPhone の Safari で開き、共有ボタン →「ホーム画面に追加」

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（画面・検索・締切） |
| `livers.json` | ライバー名簿。1行1人で、`n` 名前 / `k` よみ / `e` 英語表記 / `g` 期・ユニット / `yt` YouTubeチャンネルID / `yh` YouTubeハンドル（@の後ろ） / `a` 別名 |
| `scripts/fetch-data.mjs` | Holodex から全員分のデータを集めて `data.json` を作る |
| `.github/workflows/update.yml` | 15分ごとに上のスクリプトを動かしてサイトを公開し直す |
| `sw.js` / `manifest.webmanifest` / `icon-*.png` | ホーム画面に追加したとき用 |

## 名簿を直したいとき

GitHub で `livers.json` を開いて鉛筆ボタンで編集します。たとえば新人を足すなら、最後の人の行の後ろに `,` を付けて次の行に
`{"n": "名前", "k": "よみがな", "g": "2026年12月デビュー", "yh": "YouTubeのハンドル"}` のように1行追加して保存すれば、数分でアプリに反映されます。
YouTubeのハンドルは、チャンネルのURL `youtube.com/@○○` の ○○ の部分です。
卒業した人は、その行を消してください。

## 注意

- 非公式のファンアプリです。広く公開したり収益化したりする前に「ANYCOLOR二次創作ガイドライン」を確認してください
- X（旧Twitter）の投稿は取得していません（公式APIが有料のため）。各ライバーの画面から X を開けます
