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

accessLog: {}
log:
  level: INFO
