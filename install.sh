#!/usr/bin/env bash
# Instala, atualiza ou remove a extensão Kodō (monitor de CPU e GPU) para o usuário atual.
#
#   ./install.sh              copia src/ para a pasta de extensões e habilita
#   ./install.sh --link       modo desenvolvimento: a pasta de extensões aponta para src/
#   ./install.sh --uninstall  desabilita e remove a extensão
#
# Não precisa de sudo.
set -euo pipefail

UUID="kodo-cgpu@desktop.local"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_DIR/src"
EXT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
DEST="$EXT_ROOT/$UUID"

# Adiciona (add) ou remove (remove) o UUID da lista org.gnome.shell enabled-extensions.
set_enabled() {
    python3 - "$1" "$UUID" <<'EOF'
import ast, subprocess, sys
action, uuid = sys.argv[1], sys.argv[2]
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
items = [] if cur.startswith('@as') else ast.literal_eval(cur)
if action == 'add' and uuid not in items:
    items.append(uuid)
elif action == 'remove' and uuid in items:
    items.remove(uuid)
else:
    sys.exit(0)
subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(items)])
EOF
}

# Remove a instalação atual (link simbólico ou cópia).
remove_installed() {
    if [[ -L "$DEST" ]]; then
        rm -f -- "$DEST"
    elif [[ -d "$DEST" ]]; then
        grep -q "\"$UUID\"" "$DEST/metadata.json" 2>/dev/null \
            || { echo "Erro: $DEST não parece ser esta extensão; abortando." >&2; exit 1; }
        rm -r -- "$DEST"
    fi
}

shell_knows_extension() {
    gnome-extensions info "$UUID" >/dev/null 2>&1
}

case "${1:-}" in
    --uninstall)
        set_enabled remove
        remove_installed
        echo "Extensão removida. Ela some da tela no próximo login."
        exit 0
        ;;
    --link)
        glib-compile-schemas --strict "$SRC/schemas"
        remove_installed
        mkdir -p "$EXT_ROOT"
        ln -s "$SRC" "$DEST"
        echo "Modo desenvolvimento: $DEST -> $SRC"
        ;;
    "")
        if [[ -L "$DEST" ]]; then
            rm -f -- "$DEST"
        fi
        install -Dm644 "$SRC/metadata.json" "$DEST/metadata.json"
        install -Dm644 "$SRC/extension.js" "$DEST/extension.js"
        install -Dm644 "$SRC/stylesheet.css" "$DEST/stylesheet.css"
        install -Dm644 -t "$DEST/schemas" "$SRC"/schemas/*.gschema.xml
        glib-compile-schemas --strict "$DEST/schemas"
        echo "Instalada em $DEST"
        ;;
    *)
        echo "Uso: $0 [--link | --uninstall]" >&2
        exit 2
        ;;
esac

set_enabled add

if shell_knows_extension; then
    echo "Pronto. A extensão já está carregada nesta sessão; se o código mudou,"
    echo "saia e entre na sessão para usar a nova versão."
else
    echo "Pronto. Saia e entre na sessão para a extensão aparecer"
    echo "(ou carregue agora pelo Looking Glass, veja o README)."
fi
