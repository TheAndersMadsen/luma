# Rendered by render-envoy.py into protected storage. Never commit the rendered
# file. COSMOS_EDGE_TOKEN is the private proof that the mTLS edge, not a caller,
# supplies the authenticated device principal.
admin:
  address:
    socket_address: { address: 127.0.0.1, port_value: 9901 }

static_resources:
  listeners:
    - name: cosmos_edge
      address:
        socket_address: { address: 0.0.0.0, port_value: 8443 }
      # Listener-level log. The two http_connection_manager logs below can only
      # describe a request, and this edge's characteristic failure never produces
      # one: a device whose client certificate is missing, expired, or issued by
      # an unpinned root dies inside the TLS handshake, so no stream is created
      # and the HCM log stays empty. Nothing else records it either — the failure
      # is on the wire, the containers stay healthy, and the wearer's Pin retries
      # forever. This entry covers exactly the connections that end before a
      # request exists, and both classes were checked against this Envoy version:
      #   details=filter_chain_not_found          - SNI matched no chain
      #   tls_failure="TLS_error:…PEER_DID_NOT_RETURN_A_CERTIFICATE…"
      #                                           - handshake reached the chain
      #                                             and the client had no cert
      # A connection that does reach a filter chain and completes its handshake
      # is logged once, by the http_connection_manager below, not twice.
      # DOWNSTREAM_TRANSPORT_FAILURE_REASON is the field that separates "no
      # certificate offered" from "certificate offered and rejected"; the SNI the
      # device asked for is on the Nginx stream's line for the same connection.
      access_log:
        - name: envoy.access_loggers.file
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
            path: /dev/stdout
            log_format:
              text_format_source:
                inline_string: "edge.listener sni=%REQUESTED_SERVER_NAME% downstream=%DOWNSTREAM_REMOTE_ADDRESS% peer=%DOWNSTREAM_PEER_SUBJECT% tls_failure=\"%DOWNSTREAM_TRANSPORT_FAILURE_REASON%\" details=%RESPONSE_CODE_DETAILS% termination=%CONNECTION_TERMINATION_DETAILS% rx=%BYTES_RECEIVED% duration=%DURATION%\n"
      listener_filters:
        - name: envoy.filters.listener.tls_inspector
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
      filter_chains:
        - filter_chain_match:
            server_names: ["onboarding.cosmos.humane.cloud", "onboarding.clone.invalid", "cosmos-edge"]
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: cosmos_onboarding
                server_name: istio-envoy
                codec_type: AUTO
                forward_client_cert_details: SANITIZE_SET
                set_current_client_cert_details: { subject: true, cert: true }
                # GRPC_STATUS is the field that separates the two failures this
                # project has already paid for twice and could not tell apart:
                # code 14 with "authenticated edge principal required" (no bearer
                # attached) from code 16 UNAUTHENTICATED (bearer attached and
                # rejected). RESPONSE_FLAGS and RESPONSE_CODE_DETAILS name which
                # hop refused, and DOWNSTREAM_PEER_SUBJECT names the device whose
                # certificate the edge accepted, so a request can be attributed to
                # a Pin without correlating by timestamp.
                access_log:
                  - name: envoy.access_loggers.file
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
                      path: /dev/stdout
                      log_format:
                        text_format_source:
                          inline_string: "edge.onboarding %REQ(:METHOD)% %REQ(:PATH)% authority=%REQ(:AUTHORITY)% code=%RESPONSE_CODE% grpc=%GRPC_STATUS%/%GRPC_STATUS_NUMBER% flags=%RESPONSE_FLAGS% details=%RESPONSE_CODE_DETAILS% upstream=%UPSTREAM_HOST% peer=%DOWNSTREAM_PEER_SUBJECT% rx=%BYTES_RECEIVED% tx=%BYTES_SENT% duration=%DURATION%\n"
                route_config:
                  name: cosmos_onboarding_routes
                  virtual_hosts:
                    - name: cosmos_onboarding
                      domains: ["*"]
                      request_headers_to_remove: ["x-cosmos-edge-token", "x-cosmos-authenticated-principal"]
                      request_headers_to_add:
                        - header: { key: "x-cosmos-edge-token", value: "@@EDGE_TOKEN@@" }
                          append_action: OVERWRITE_IF_EXISTS_OR_ADD
                      routes:
                        - match: { prefix: "/humane.provisioning." }
                          route: { cluster: cosmos_provisioning, timeout: 30s }
                        - match: { prefix: "/grpc.health.v1." }
                          route: { cluster: cosmos_provisioning, timeout: 30s }
                        - match: { prefix: "/" }
                          direct_response: { status: 404 }
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
          transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              require_client_certificate: true
              common_tls_context:
                alpn_protocols: ["h2"]
                tls_params:
                  tls_minimum_protocol_version: TLSv1_2
                  tls_maximum_protocol_version: TLSv1_3
                tls_certificates:
                  - certificate_chain: { filename: "@@CERT_DIR@@/server.crt" }
                    private_key: { filename: "@@CERT_DIR@@/server.key" }
                validation_context:
                  trusted_ca: { filename: "@@CERT_DIR@@/onboarding-client-ca.crt" }
        - filter_chain_match:
            server_names: ["api.cosmos.humane.cloud", "api.clone.invalid", "eastus.cosmos.humane.cloud", "eastus-1.cosmos.humane.cloud"]
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: cosmos_api
                server_name: istio-envoy
                codec_type: AUTO
                forward_client_cert_details: SANITIZE_SET
                set_current_client_cert_details: { subject: true, cert: true }
                # Same format as the onboarding chain, and the same reason. This
                # is the device's whole redirected gRPC plane — push relay, ai
                # bus, capture, privacy — and until now it produced no request
                # line anywhere, at any status.
                access_log:
                  - name: envoy.access_loggers.file
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
                      path: /dev/stdout
                      log_format:
                        text_format_source:
                          inline_string: "edge.api %REQ(:METHOD)% %REQ(:PATH)% authority=%REQ(:AUTHORITY)% code=%RESPONSE_CODE% grpc=%GRPC_STATUS%/%GRPC_STATUS_NUMBER% flags=%RESPONSE_FLAGS% details=%RESPONSE_CODE_DETAILS% upstream=%UPSTREAM_HOST% peer=%DOWNSTREAM_PEER_SUBJECT% rx=%BYTES_RECEIVED% tx=%BYTES_SENT% duration=%DURATION%\n"
                route_config:
                  name: cosmos_api_routes
                  virtual_hosts:
                    - name: cosmos_api
                      domains: ["*"]
                      request_headers_to_remove: ["x-cosmos-edge-token", "x-cosmos-authenticated-principal"]
                      request_headers_to_add:
                        - header: { key: "x-cosmos-edge-token", value: "@@EDGE_TOKEN@@" }
                          append_action: OVERWRITE_IF_EXISTS_OR_ADD
                      routes:
                        - match: { prefix: "/humane.featureflags." }
                          route: { cluster: cosmos_feature_flags, timeout: 30s }
                        - match: { prefix: "/humane.aibus." }
                          route: { cluster: cosmos_ai_bus, timeout: 30s }
                        - match: { prefix: "/humane.privacy.grpc.pub." }
                          route: { cluster: cosmos_ai_bus, timeout: 30s }
                        - match: { prefix: "/humane.capture." }
                          route: { cluster: cosmos_ai_bus, timeout: 30s }
                        - match: { prefix: "/humane.partnerservices." }
                          route: { cluster: cosmos_ai_bus, timeout: 30s }
                        - match: { path: "/humane.pushrelay.PushRelayService/Subscribe" }
                          route: { cluster: cosmos_ai_bus, timeout: 0s }
                        - match: { prefix: "/humane.pushrelay." }
                          route: { cluster: cosmos_ai_bus, timeout: 30s }
                        - match: { prefix: "/humane.location.v1." }
                          route: { cluster: cosmos_ai_bus, timeout: 30s }
                        - match: { prefix: "/humane.account." }
                          route: { cluster: cosmos_account, timeout: 30s }
                        - match: { prefix: "/humane.contacts." }
                          route: { cluster: cosmos_contacts, timeout: 30s }
                        - match: { prefix: "/humane.events." }
                          route: { cluster: cosmos_notable_events, timeout: 30s }
                        - match: { prefix: "/grpc.health.v1." }
                          route: { cluster: cosmos_feature_flags, timeout: 30s }
                        - match: { prefix: "/" }
                          direct_response: { status: 404 }
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
          transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              require_client_certificate: true
              common_tls_context:
                alpn_protocols: ["h2"]
                tls_params:
                  tls_minimum_protocol_version: TLSv1_2
                  tls_maximum_protocol_version: TLSv1_3
                tls_certificates:
                  - certificate_chain: { filename: "@@CERT_DIR@@/server.crt" }
                    private_key: { filename: "@@CERT_DIR@@/server.key" }
                validation_context:
                  trusted_ca: { filename: "@@CERT_DIR@@/api-client-ca.crt" }
  clusters:
    - name: cosmos_feature_flags
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: cosmos_feature_flags
        endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: feature-flags, port_value: 15051 } } } }] }]
    - name: cosmos_ai_bus
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: cosmos_ai_bus
        endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: ai-bus, port_value: 15051 } } } }] }]
    - name: cosmos_account
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: cosmos_account
        endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: account, port_value: 15051 } } } }] }]
    - name: cosmos_contacts
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: cosmos_contacts
        endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: contacts, port_value: 15051 } } } }] }]
    - name: cosmos_notable_events
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: cosmos_notable_events
        endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: notable-events, port_value: 15051 } } } }] }]
    - name: cosmos_provisioning
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: cosmos_provisioning
        endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: provisioning, port_value: 15051 } } } }] }]
