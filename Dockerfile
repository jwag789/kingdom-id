# Kingdom ID provider image. Builds the workspace, then deploys only the idp
# package and its production dependencies into a slim runtime layer.
FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@kingdom-id/idp..." \
 && pnpm --filter "@kingdom-id/idp..." build \
 && pnpm --filter @kingdom-id/idp deploy --prod --legacy /out

FROM node:26-alpine
LABEL org.opencontainers.image.source=https://github.com/jwag789/kingdom-id
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
