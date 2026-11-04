# くまの記録(Recording_Health)

毎日の体調(ぐるぐる・痛み)と服薬・飲酒を、本人が iPhone で 20 秒で記録し、医師に見せる PDF レポートを出すための家族用アプリ。
Apple Watch / iPhone ヘルスケアの睡眠・歩数は、ショートカットの自動化で毎朝取り込む。

## 構成

```
iPhone(本人)  ホーム画面の Web アプリ(PWA) ──┐
iPhone(本人)  ショートカット(睡眠・歩数を毎朝送信) ─┼─→ Google Apps Script(API) ─→ Google スプレッドシート(データ)
PC / スマホ(サポーター) 同じ Web アプリ ─────────┘
PC            レポート画面 → 印刷 → PDF
```

- 画面: `docs/`(GitHub Pages で公開する静的ファイル)。素の HTML / CSS / JavaScript、ビルド不要。
- API とデータ: `apps-script/`(Google Apps Script にそのまま貼る)。データはスプレッドシートの各シートに1行1レコードで入る。
- ローカル確認: `dev/`(Node.js だけで動く開発サーバーとダミーデータ生成)。

| パス | 役割 |
|---|---|
| `docs/index.html`, `docs/app.js`, `docs/style.css` | アプリ本体(本人の画面とサポーターの画面は同じファイル。ログイン時の役割で切り替わる) |
| `docs/report.html`, `docs/report.js` | 医師向けレポート(印刷 → PDF) |
| `docs/config.js` | API の URL を書く配布設定 |
| `docs/images/images.js`, `docs/images/*` | くまの画像とリアクションの種類の設定。自分の画像への差し替え・追加はここ(`IMAGES.md`) |
| `docs/manifest.webmanifest`, `docs/sw.js`, `docs/icons/` | ホーム画面に追加するための PWA 設定とアイコン |
| `apps-script/kuma-api.gs` | API のプログラム。Google Apps Script にはこれ 1 つを貼る。ローカルサーバーも同じファイルを読み込む |
| `apps-script/appsscript.json` | Apps Script のマニフェスト。タイムゾーンを日本にしたい時だけ使う(SETUP.md 1 の付録) |
| `dev/server.js` | ローカル開発サーバー(`node dev/server.js` → http://localhost:8787、家族コード `kuma`) |
| `dev/seed.js` | 30日分のダミーデータを入れる(`node dev/seed.js`) |
| `SETUP.md` | 公開までの手順(スプレッドシート、Apps Script、GitHub Pages、iPhone) |
| `SHORTCUTS.md` | ヘルスケア連携。サポーターがショートカットを 1 回だけ作って共有し、本人はアプリで同意するだけ |
| `IMAGES.md` | 画像の差し替え、新しい画像の登録、リアクションの種類の追加 |
| `private/` | 家族の相談の記録(`shared-chat-transcript.md`)と設計メモ(`PROPOSAL.md`)。病名・薬・名前を含むので **GitHub には上げない**(`.gitignore` で除外済み) |

## 使い方の要点

- 本人: 朝は「朝の薬」「コンサータ」を飲んだらタップ(時刻が入る)。夜は寝る前の薬を飲んだあとに「きょうのチェックイン」(ぐるぐる 0〜10、痛み 0〜10、お酒、寝る前の薬)。
- 押し忘れた服薬は、記録済みボタンをタップして時刻を直せる。「一部だけ飲んだ」もそこで記録できる。
- サポーター: 「記録」タブで日付を選んで代わりに入力・修正、「リアクション」タブで本人の画面にひとこと、「一覧」タブからレポートを開く。
- 日付の区切りは午前4時。深夜1時に飲んだ寝る前の薬は前日の記録になる。
- ヘルスケア(眠り・歩数): 本人がアプリで「同意」すると、朝に「昨夜の眠りを取り込む」を押すだけで入る。同意していない間、サーバーは健康データを保存しない。

## ローカルで動かす

```
node dev/server.js        # http://localhost:8787 を開く。家族コードは kuma
node dev/seed.js          # 30日分のダミーデータ(別のターミナルで)
SLOW=1500 node dev/server.js   # Apps Script の遅さ(約1.5秒)を再現
```

## 公開する

`SETUP.md` を順番に進める。コードを変えたときは、`docs/` を GitHub に上げ直し、`apps-script/` を変えた場合は Apps Script で「新バージョン」としてデプロイし直す。
