FROM nginx:alpine
ARG VITE_API_BASE=
COPY index.html /usr/share/nginx/html/index.html
RUN sed -i "s|__VITE_API_BASE__|${VITE_API_BASE}|g" /usr/share/nginx/html/index.html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
