FROM node:24-bookworm-slim AS upstream
# Fetch the exact original version in Railway's build environment. The 210k+
# asset files stay out of the CLI upload; the running image still contains them.
ADD https://codeload.github.com/shines871/idle-lineage-class/tar.gz/b3fb21ce1960954adbbfcaa8f6dde9c8642d208b /tmp/upstream.tar.gz
RUN mkdir /upstream && tar -xzf /tmp/upstream.tar.gz -C /upstream --strip-components=1

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY package.json index.html ./
COPY server ./server
COPY shared ./shared
COPY online ./online
COPY js ./js
COPY css ./css
COPY --from=upstream /upstream/assets ./assets
COPY --from=upstream /upstream/public ./public
RUN mkdir -p /data
EXPOSE 8787
CMD ["node", "server/index.mjs"]
