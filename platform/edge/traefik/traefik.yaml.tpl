api:
  dashboard: false

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  file:
    filename: /etc/traefik/dynamic.yaml
    watch: false

certificatesResolvers:
  letsencrypt:
    acme:
      email: "@@ACME_EMAIL@@"
      storage: /var/lib/traefik/acme.json
      httpChallenge:
        entryPoint: web

accessLog:
  fields:
    # Room join URLs contain bearer credentials. Keep route/status evidence,
    # but never persist query values (including v1's encoded join request).
    queryParameters:
      defaultMode: drop
log:
  level: INFO
