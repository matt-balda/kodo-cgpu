#!/usr/bin/env bash
# Roda scripts/test-headless.sh em várias versões do GNOME Shell, cada uma num container
# Docker com o Ubuntu que trouxe aquela versão. Não mexe na sua sessão nem no sistema.
#
#   scripts/test-matrix.sh [versão ...]      ex.: scripts/test-matrix.sh 45 46
#                                            (padrão: 45 46 47 48 49 50 51)
#
# Resultados em test-output/gnome-<versão>/: capturas, log do Shell e saída do teste.
# As imagens se chamam kodo-gnome-test:<versão> (cerca de 1 GB cada). Para apagar todas:
#   docker rmi $(docker images -q kodo-gnome-test)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
declare -A UBUNTU=([45]=23.10 [46]=24.04 [47]=24.10 [48]=25.04 [49]=25.10 [50]=26.04 [51]=26.10)
VERSIONS=("$@")
[[ ${#VERSIONS[@]} -gt 0 ]] || VERSIONS=(45 46 47 48 49 50 51)
for v in "${VERSIONS[@]}"; do
    if [[ -z "${UBUNTU[$v]:-}" ]]; then
        echo "Versão desconhecida: $v (disponíveis: 45 a 51)" >&2
        exit 2
    fi
done

# GNOME Shell com o tema e a dock do Ubuntu, mais o que o test-headless.sh usa.
# Versões do Ubuntu fora de suporte ficam em old-releases.ubuntu.com.
DOCKERFILE=$(cat <<'EOF'
ARG BASE
FROM ${BASE}
ARG UID=1000
ENV DEBIAN_FRONTEND=noninteractive
RUN set -e; \
    if ! apt-get update; then \
        for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do \
            if [ -f "$f" ]; then sed -i -E 's#https?://(archive|security)\.ubuntu\.com/ubuntu#http://old-releases.ubuntu.com/ubuntu#g' "$f"; fi; \
        done; \
        apt-get update; \
    fi; \
    extra=""; \
    for p in yaru-theme-gnome-shell gnome-shell-extension-ubuntu-dock yaru-theme-icon adwaita-icon-theme \
             fonts-cantarell fonts-ubuntu libgl1-mesa-dri libegl-mesa0 librsvg2-common; do \
        if apt-cache show "$p" > /dev/null 2>&1; then extra="$extra $p"; else echo "AVISO: sem o pacote $p"; fi; \
    done; \
    apt-get install -y --no-install-recommends gnome-shell dbus libglib2.0-bin $extra; \
    rm -rf /var/lib/apt/lists/*; \
    useradd -m -o -u "$UID" -s /bin/bash tester
USER tester
ENV HOME=/home/tester USER=tester LANG=C.UTF-8
EOF
)

# --- imagens (em paralelo) ------------------------------------------------------
echo "Preparando imagens do GNOME ${VERSIONS[*]} (na primeira vez baixa cada Ubuntu)..."
declare -A PID RESULT
for v in "${VERSIONS[@]}"; do
    out="$REPO_DIR/test-output/gnome-$v"
    mkdir -p "$out"
    docker build --build-arg BASE="ubuntu:${UBUNTU[$v]}" --build-arg UID="$(id -u)" \
        -t "kodo-gnome-test:$v" - <<< "$DOCKERFILE" > "$out/docker-build.log" 2>&1 &
    PID[$v]=$!
done
for v in "${VERSIONS[@]}"; do
    wait "${PID[$v]}" || RESULT[$v]="FALHA ao criar a imagem (veja test-output/gnome-$v/docker-build.log)"
done

# --- testes (um de cada vez) ----------------------------------------------------
for v in "${VERSIONS[@]}"; do
    [[ -z "${RESULT[$v]:-}" ]] || continue
    out="$REPO_DIR/test-output/gnome-$v"
    echo
    echo "===== GNOME $v (Ubuntu ${UBUNTU[$v]}) ====="
    if docker run --rm -v "$REPO_DIR:/repo:ro" -v "$out:/out" "kodo-gnome-test:$v" \
            bash /repo/scripts/test-headless.sh /out 2>&1 | tee "$out/teste.txt"; then
        RESULT[$v]="OK"
    else
        RESULT[$v]="FALHA (veja test-output/gnome-$v/teste.txt)"
    fi
done

echo
echo "Resumo:"
status=0
for v in "${VERSIONS[@]}"; do
    printf '  GNOME %s (Ubuntu %-5s)  %s\n' "$v" "${UBUNTU[$v]}" "${RESULT[$v]}"
    [[ "${RESULT[$v]}" == OK ]] || status=1
done
exit "$status"
