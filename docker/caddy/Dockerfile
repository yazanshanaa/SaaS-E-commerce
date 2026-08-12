# Caddy with the Cloudflare DNS provider compiled in.
#
# The stock `caddy:2` image cannot obtain the platform's wildcard certificate. `*.souqbartaa.com`
# is only issuable through a DNS-01 challenge — HTTP-01 cannot answer for a wildcard — and the
# DNS-01 solver needs a provider module that speaks to the DNS host's API. That module is not in
# the standard build, so the image has to be built. This is the `caddy-dns/cloudflare` module
# CLAUDE.md's stack section names, and the reason platform DNS lives on Cloudflare rather than at
# the registrar (docs/DOMAINS.md).
#
# The alternative — one certificate per storefront subdomain over HTTP-01 — is what this avoids:
# every merchant on the box shares one Let's Encrypt account, and its issuance limits are counted
# per week. A hundred storefronts would spend the quota that a merchant adding a real custom
# domain then needs, and the recovery is measured in days for everybody rather than for the one
# who caused it.

ARG CADDY_VERSION=2.10

FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build \
  --with github.com/caddy-dns/cloudflare

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
