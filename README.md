# dsh-set-compaction

Ставит порог автокомпрессии DeepSeek Harness на заданное число токенов — например, 250 000 вместо дефолтных 727 040.

## Установка

1. Скачать скрипт:

   macOS / Linux:

    curl -sSL -o set-compaction.cjs https://raw.githubusercontent.com/ykurilov/dsh-set-compaction/main/set-compaction.cjs

   Windows (PowerShell):

    Invoke-WebRequest -Uri https://raw.githubusercontent.com/ykurilov/dsh-set-compaction/main/set-compaction.cjs -OutFile set-compaction.cjs

   Если `curl.exe` в Windows падает с ошибкой schannel — это его TLS-стек, используйте вариант с `Invoke-WebRequest` выше.

   Если raw.githubusercontent.com недоступен (таймаут GitHub), зеркало:

    curl -sSL -o set-compaction.cjs https://cdn.jsdelivr.net/gh/ykurilov/dsh-set-compaction@main/set-compaction.cjs

   Windows-зеркало:

    Invoke-WebRequest -Uri https://cdn.jsdelivr.net/gh/ykurilov/dsh-set-compaction@main/set-compaction.cjs -OutFile set-compaction.cjs

2. Запустить:

    node set-compaction.cjs 250000

   Если `node` не установлен, возьмите тот, что уже есть у DSH:

    macOS:    ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
    Windows:  %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
              (если его там нет — тот же путь без \bin\)

3. Полностью выйти из DSH и открыть заново: macOS — Cmd+Q, Windows — трей → «Выйти». Закрытие окна не считается.

## Что делает

- находит DSH home (`DSH_HOME` или `~/.dsh`), профиль (`desktop`) и `cordis.patch.yml`;
- берёт из последней сессии `contextWindow` (W) и id активного пресета;
- достаёт `config` пресета из `app.asar` (`dsh/node_modules/@deepseek-ai/dsh-web-app/presets/<пресет>.patch.yml`);
- вписывает в `compaction-basic`: `thresholdRatio = N / W` и `retainTokens: 60000`;
- заменяет существующую запись `preset-<id>` или дописывает её в конец файла;
- делает бэкап `cordis.patch.yml` рядом с оригиналом.

## Проверка

После перезапуска новая сессия сжимается на N токенах (при N = 250000 и окне 1 048 576 — на 250 000, что видно по падению `contextPressure.pressureTokens`), а не на 727 040.
