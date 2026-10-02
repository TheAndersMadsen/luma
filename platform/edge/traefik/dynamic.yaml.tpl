# Traefik evaluates TCP routers before HTTP routers on one entry point. The Pin
# names pass through unchanged to Envoy, preserving its client certificate;
# ordinary HTTPS is terminated here for Center and Keycloak.
tcp:
  routers:
    pin-edge:
      entryPoints: [websecure]
      rule: "HostSNI(`api.cosmos.humane.cloud`) || HostSNI(`api.clone.invalid`) || HostSNI(`eastus.cosmos.humane.cloud`) || HostSNI(`eastus-1.cosmos.humane.cloud`) || HostSNI(`onboarding.cosmos.humane.cloud`) || HostSNI(`onboarding.clone.invalid`) || HostSNI(`cosmos-edge`)"
      service: pin-edge
      priority: 200
      tls:
        passthrough: true
  services:
    pin-edge:
      loadBalancer:
        servers:
          - address: edge:8443

http:
  routers:
    connectivity:
      entryPoints: [web]
      rule: "Host(`connectivity-check.cosmos.humane.cloud`) || Host(`n.cosmos.humane.cloud`)"
      service: connectivity
      priority: 200
    redirect-http:
      entryPoints: [web]
      rule: "PathPrefix(`/`)"
      service: center
      middlewares: [redirect-https]
      priority: 1
    # Keycloak publishes only the wearer realm's sign-in and its theme assets.
    # `/admin/` is Center's operator pages, never Keycloak's admin console.
    identity:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && (PathPrefix(`/realms/humane`) || PathPrefix(`/resources/`))"
      service: keycloak
      middlewares: [secure-headers]
      priority: 150
      tls:
        certResolver: letsencrypt
    # The Pin's only public HTTPS call to Cosmos: the capture upload whose URL
    # CaptureService.UploadFile mints (`PUT /capture/<capability>`). The capture
    # read API stays on the internal network, where Center calls it.
    capture-upload:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && Method(`PUT`) && PathRegexp(`^/capture/[A-Za-z0-9_-]+$`)"
      service: ai-bus
      middlewares: [secure-headers]
      priority: 120
      tls:
        certResolver: letsencrypt
    device-status:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && Path(`/device-status/v1/report`)"
      service: ai-bus
      middlewares: [secure-headers]
      priority: 130
      tls:
        certResolver: letsencrypt
    center:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`)"
      service: center
      middlewares: [secure-headers]
      priority: 10
      tls:
        certResolver: letsencrypt
  middlewares:
    # Attached to every entry point in traefik.yaml, so no public request can
    # carry an internal identity marker or its proof to a workload. Traefik
    # removes a request header configured with an empty value.
    strip-internal-identity:
      headers:
        customRequestHeaders:
          X-Forwarded-Client-Cert: ""
          X-Cosmos-Edge-Token: ""
          X-Cosmos-Web-Projection-Token: ""
    redirect-https:
      redirectScheme:
        scheme: https
        permanent: true
    secure-headers:
      headers:
        contentTypeNosniff: true
        frameDeny: true
        referrerPolicy: same-origin
        stsSeconds: 31536000
  services:
    connectivity:
      loadBalancer:
        servers:
          - url: http://connectivity:18080
    ai-bus:
      loadBalancer:
        servers:
          - url: http://ai-bus:18080
    keycloak:
      loadBalancer:
        servers:
          - url: http://keycloak:8080
    center:
      loadBalancer:
        servers:
          - url: http://center:4000
