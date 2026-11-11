# くまの記録(Recording_Health)

家族が毎日のようすを記録し、医師に見せる PDF レポートを出すための家族用アプリ。
本人には体調のことを何もたずねない(たずねると痛みを思い出してしまうため)。記録するのは家族で、見て分かることだけを残す。
Apple Watch / iPhone の眠りと歩数は、本人の iPhone のショートカットから毎日自動で届く。

## 構成

```
iPhone(家族)  Web アプリ(PWA)「記録する人」 ──────┐
iPhone(本人)  Web アプリ(PWA)「本人」= くまの部屋 ──┼─→ Google Apps Script(API) ─→ Google スプレッドシート(データ)
iPhone(本人)  ショートカット(眠り・歩数を自動で送信) ─┘
PC            レポート画面 → 印刷 → PDF
```

- 画面: `docs/`(GitHub Pages で公開する静的ファイル)。素の HTML / CSS / JavaScript、ビルド不要。
- API とデータ: `apps-script/`(Google Apps Script にそのまま貼る)。データはスプレッドシートの各シートに1行1レコードで入る。
- ローカル確認: `dev/`(Node.js だけで動く開発サーバーとダミーデータ生成)。

| パス | 役割 |
|---|---|
| `docs/index.html`, `docs/app.js`, `docs/style.css` | アプリ本体(記録する人の画面と本人の画面は同じファイル。ログイン時の役割で切り替わる) |
| `docs/report.html`, `docs/report.js` | 医師向けレポート(印刷 → PDF) |
| `docs/config.js` | API の URL を書く配布設定 |
| `docs/images/images.js`, `docs/images/*` | くまの画像とひとことの種類の、もとの設定。サイトの「くま」タブで登録した画像と設定が優先される(`IMAGES.md`) |
| `docs/manifest.webmanifest`, `docs/sw.js`, `docs/icons/` | ホーム画面に追加するための PWA 設定とアイコン |
| `apps-script/kuma-api.gs` | API のプログラム。Google Apps Script にはこれ 1 つを貼る。ローカルサーバーも同じファイルを読み込む |
| `apps-script/appsscript.json` | Apps Script のマニフェスト。タイムゾーンを日本にしたい時だけ使う(SETUP.md 1 の付録) |
| `dev/server.js` | ローカル開発サーバー(`node dev/server.js` → http://localhost:8787、家族コード `kuma`) |
| `dev/seed.js` | 30日分のダミーデータを入れる(`node dev/seed.js`) |
| `SETUP.md` | 公開までの手順(スプレッドシート、Apps Script、GitHub Pages、iPhone) |
| `SHORTCUTS.md` | 眠りと歩数の連携。記録する人がショートカットを 1 回だけ作り、本人は「同意」するだけ。あとは自動 |
| `IMAGES.md` | 画像の登録・差し替えと、ひとことの種類の追加 |
| `private/` | 家族の相談の記録と設計メモ。病名・薬・名前を含むので **GitHub には上げない**(`.gitignore` で除外済み) |

## 使い方の要点

- 記録する人(家族): 「記録」タブで、その日のようすをボタンで記録する。朝のようす、日中のようす(食事の量と寝る前の間食を含む)、見た目のようす・本人のことば(不随意運動の見た目 1〜5、本人が自分から口にしたこと)、楽そうだった時間・できたこと、おくすり(押すと今の時刻、長押しで時刻を入力。頓服は飲むたびに押す)、アルコール。カテゴリーごとに備考欄がある。押した内容はその場で保存される。
- 本人: アプリを開くと、くまと家族からのひとことだけが出る。体調・薬・記録のことは一切出ない。本人の端末からは記録の中身を読めない。
- 眠りと歩数: 本人が一度「同意」すると、本人の iPhone のショートカットが毎日自動で送る。同意していない間、サーバーは健康データを保存しない。
- 画像: 「くま」タブから、iPhone の写真を登録して、場面ごとのくまやひとことの絵に使える。画像はスプレッドシートに保存され、GitHub には上がらない。
- 日付の区切りは午前4時。深夜1時の出来事は前日の記録になる。

## ローカルで動かす

```
node dev/server.js        # http://localhost:8787 を開く。家族コードは kuma
node dev/seed.js          # 30日分のダミーデータ(別のターミナルで)
SLOW=1500 node dev/server.js   # Apps Script の遅さ(約1.5秒)を再現
```

## 公開する

`SETUP.md` を順番に進める。コードを変えたときは、`docs/` を GitHub に上げ直し、`apps-script/` を変えた場合は Apps Script で「新バージョン」としてデプロイし直す。
