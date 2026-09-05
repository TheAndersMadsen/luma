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
    identity:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && (PathPrefix(`/realms/humane`) || PathPrefix(`/resources/`) || PathPrefix(`/admin/`))"
      service: keycloak
      middlewares: [secure-headers]
      priority: 150
      tls:
        certResolver: letsencrypt
    capture:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && PathPrefix(`/capture/`)"
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
    native-runtime-bootstrap:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && (Path(`/runtime-api/v1/native/challenge`) || Path(`/runtime-api/v1/native/open`) || Path(`/runtime-api/v1/native/room`))"
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
    livekit:
      entryPoints: [websecure]
      rule: "Host(`@@PUBLIC_DOMAIN@@`) && PathPrefix(`/livekit/`)"
      service: livekit
      middlewares: [livekit-prefix, secure-headers]
      priority: 140
      tls:
        certResolver: letsencrypt
  middlewares:
    livekit-prefix:
      stripPrefix:
        prefixes: [/livekit]
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
    livekit:
      loadBalancer:
        servers:
          - url: http://livekit:7880
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
