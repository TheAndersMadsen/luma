api:
  dashboard: false

entryPoints:
  web:
    address: ":80"
    http:
      middlewares: [strip-internal-identity@file]
  websecure:
    address: ":443"
    http:
      middlewares: [strip-internal-identity@file]
  # Serves the ping endpoint for the container healthcheck. In v3.6 a
  # config file suppresses the auto-created `traefik` entrypoint and CLI
  # --ping is ignored, so both the entrypoint and ping live here.
  traefik:
    address: ":8080"

ping: {}

# The operator overlay mounts Luma's rendered routes as 10-luma.yaml and, when
# the owner keeps one, the owner's extra routes as 20-extra.yaml.
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: false

certificatesResolvers:
  letsencrypt:
    acme:
      email: "@@ACME_EMAIL@@"
      storage: /var/lib/traefik/acme.json
      httpChallenge:
        entryPoint: web

accessLog: {}
log:
  level: INFO
