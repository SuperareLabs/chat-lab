FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY package.json telegram.mjs ./
COPY lib/ ./lib/
COPY config/ ./config/
COPY character-packs/ ./character-packs/
COPY public/telegram-admin/ ./public/telegram-admin/
USER node
ENV NODE_OPTIONS=--max-old-space-size=160
ENV TELEGRAM_DATA_DIR=/var/lib/chat-lab-telegram
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "--input-type=module", "-e", "import {readFileSync} from 'node:fs'; process.exit(Date.now()-Number(readFileSync('/var/lib/chat-lab-telegram/heartbeat','utf8'))<120000?0:1)"]
CMD ["node", "--env-file=config/runtime.env", "telegram.mjs"]
