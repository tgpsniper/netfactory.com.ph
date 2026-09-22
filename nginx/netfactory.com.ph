# Connection header must follow whether the client actually asked for an upgrade.
# Hardcoding "upgrade" on /api/ told the upstream every ordinary request was a protocol
# switch; short responses slipped through, but the 8s ONU-detail call (which opens an SSH
# session to the OLT) came back as a failed fetch and the panel rendered "No ONU mapped"
# for an ONU that was online.
map $http_upgrade $nf_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    server_name netfactory.com.ph www.netfactory.com.ph;
    root /var/www/netfactory.com.ph/html;
    index index.html;

    # Let's Encrypt ACME challenge — MUST be allowed before the dotfile deny below
    location ^~ /.well-known/acme-challenge/ {
        allow all;
        root /var/www/netfactory.com.ph/html;
        default_type "text/plain";
    }

    location ~ /\. { deny all; access_log off; log_not_found off; }  # block .git/.env/.claude etc.
    # Socket.IO lives at /socket.io/, not under /api/, so it fell through to the
    # try_files block below and 404d — the CRM retried the handshake forever and live
    # status never updated. HTTP/1.1 + the Upgrade headers are what let it become a
    # WebSocket; without them nginx would proxy the request but never upgrade it.
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $nf_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 7d;      # idle sockets must not be culled mid-session
        proxy_send_timeout 7d;
    }

    # Firmware images, before the general /api/ rule — ^~ so neither of these can be
    # taken by a regex location, and so they are not capped by the 50m below.
    # Nothing has ever been uploaded through either path; without these the first
    # attempt would have failed exactly the way the application form did.
    location ^~ /api/upload-firmware {
        client_max_body_size 256m;      # matches multer in firmware-upload.js
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $nf_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location ^~ /api/admin/tr069/ {
        client_max_body_size 80m;       # matches firmwareUpload in tr069.js
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $nf_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location /api/ {
        # Without this nginx applies its 1m default, and every upload larger than that
        # is refused BEFORE it reaches the API — which then never gets to enforce its
        # own limits or return a JSON error. The public application form advertises
        # "max 10MB each" across four attachments and multer is configured to match, so
        # a 1.16MB ID photo was rejected by the web server with an HTML 413 page that
        # the form then tried to JSON.parse ("Unexpected token '<'"). 21 failed
        # submissions on 15 Sep from one applicant, plus 6 on /api/admin/surveys.
        #
        # 50m = the 4 x 10MB the form promises, plus multipart overhead and headroom.
        # The API stays the authority on what is actually accepted; this only stops
        # nginx from cutting the request off before the API can answer.
        client_max_body_size 50m;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $nf_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    # TR-069 endpoint on the main hostname.
    #
    # A fleet of CPEs was provisioned before this ACS existed with an ACS URL of
    # http://netfactory.com.ph/acs/ — 30 distinct devices, 458 POSTs on 07 Sep alone,
    # every one answered 404 because nothing served that path. They are healthy and
    # informing on schedule; only the door was missing. Serving it here onboards them
    # with no CPE-side change, which beats re-provisioning 30 units by hand.
    #
    # cwmp.netfactory.com.ph stays the canonical endpoint for anything provisioned
    # from now on; this is the compatibility path for what is already in the field.
    #
    # ^~ so no regex location can take it, and the trailing slash on proxy_pass strips
    # /acs/ before handing the request to GenieACS, which serves CWMP at the root.
    location ^~ /acs/ {
        proxy_pass http://127.0.0.1:7547/;
        proxy_http_version 1.1;

        # A TR-069 session is a run of POSTs that must keep the same connection state,
        # so keepalive stays on and the hop-by-hop Connection header is cleared rather
        # than set to "upgrade" — this vhost's $nf_connection_upgrade map is for
        # WebSockets and would break a CWMP session.
        proxy_set_header Connection        "";
        proxy_set_header Host              $host;
        # GenieACS records the address it will send connection requests back to, so the
        # CPE's real IP has to survive the proxy.
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Informs can sit while the ACS walks a large parameter tree.
        proxy_connect_timeout 30s;
        proxy_send_timeout    300s;
        proxy_read_timeout    300s;
        proxy_buffering       off;

        client_max_body_size 128m;

        access_log /var/log/nginx/cwmp-access.log;
        error_log  /var/log/nginx/cwmp-error.log;
    }

    location /     { try_files $uri $uri/ =404; }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/netfactory.com.ph/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/netfactory.com.ph/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot


}
server {
    listen 80;
    server_name netfactory.com.ph www.netfactory.com.ph;

    # TR-069 over plain HTTP.
    #
    # Certbot's original version of this block redirected every port-80 request to HTTPS
    # with a server-level `if`. That `if` is evaluated in the rewrite phase, BEFORE nginx
    # selects a location, so no location could ever have exempted /acs/ — a CWMP POST was
    # answered with a 301, and CPEs do not follow redirects on a SOAP POST.
    #
    # That left ONU firmware which cannot negotiate TLS to an ACS with no working
    # endpoint at all: http returned 301, and pointing it at https unbound its TR-069
    # client entirely (Access to Onu URL fell back to 0.0.0.0).
    #
    # Rewritten as locations so the redirect is `location /` and /acs/ sits beside it.
    # Every other path behaves exactly as before — still a 301 to HTTPS. Only the CWMP
    # endpoint answers over plain HTTP.
    #
    # Trade-off, taken deliberately: CWMP on port 80 means inform traffic and any
    # ConnectionRequest credentials cross the access network in the clear. These CPEs
    # reach the ACS over the ISP's own CGNAT path rather than the public internet, and
    # the alternative is no TR-069 management at all on this hardware. The HTTPS
    # endpoint remains available and preferred for every device that can use it.
    location ^~ /acs/ {
        proxy_pass http://127.0.0.1:7547/;
        proxy_http_version 1.1;
        proxy_set_header Connection        "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout    300s;
        proxy_read_timeout    300s;
        proxy_buffering       off;
        client_max_body_size 128m;
        # Separate log so HTTP informs can be told apart from HTTPS ones at a glance.
        access_log /var/log/nginx/cwmp-http-access.log;
        error_log  /var/log/nginx/cwmp-http-error.log;
    }

    # ACME must stay reachable over plain HTTP or certificate renewal breaks.
    location ^~ /.well-known/acme-challenge/ {
        allow all;
        root /var/www/netfactory.com.ph/html;
        default_type "text/plain";
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
