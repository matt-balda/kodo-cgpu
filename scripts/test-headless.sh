#!/usr/bin/env bash
# Testa a extensão num GNOME Shell "headless" (sem tela) isolado: D-Bus, configurações
# e pastas próprios, então nada da sua sessão é afetado e não é preciso sair dela.
# Gera capturas de tela, o log do GNOME Shell e informa o estado da extensão. Também usa
# os menus da extensão (modo, posição, valores na barra) e a desativa/reativa, conferindo
# o resultado de cada passo. Para rodar em várias versões do GNOME: scripts/test-matrix.sh
#
#   scripts/test-headless.sh [pasta-de-saída]      (padrão: ./test-output)
#
# Variáveis opcionais: WAIT_SECONDS (padrão 6) = tempo coletando dados antes da captura.
set -euo pipefail

UUID="kodo-cgpu@desktop.local"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(realpath -m "${1:-$REPO_DIR/test-output}")"
WAIT_SECONDS="${WAIT_SECONDS:-6}"
TMP="$(mktemp -d -t cgm-test.XXXXXX)"
LOG="$OUT/gnome-shell.log"
mkdir -p "$OUT"

SHELL_PID=""
BUS_PIDS=()
cleanup() {
    if [[ -n "$SHELL_PID" ]]; then
        kill "$SHELL_PID" 2>/dev/null || true
        wait "$SHELL_PID" 2>/dev/null || true
    fi
    for pid in "${BUS_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    rm -rf -- "${TMP:?}"
}
trap cleanup EXIT

# --- ambiente isolado -------------------------------------------------------
mkdir -p "$TMP"/{runtime,cache,state,config/glib-2.0/settings,data/gnome-shell/extensions}
chmod 700 "$TMP/runtime"
EXT_DIR="$TMP/data/gnome-shell/extensions"

cp -r "$REPO_DIR/src" "$EXT_DIR/$UUID"
glib-compile-schemas --strict "$EXT_DIR/$UUID/schemas"

# Extensão auxiliar (só existe no teste): liga o "unsafe mode" para liberar
# org.gnome.Shell.Eval e a captura de tela via D-Bus neste shell isolado.
SHELL_MAJOR="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
mkdir -p "$EXT_DIR/test-helper@local"
cat > "$EXT_DIR/test-helper@local/metadata.json" <<EOF
{"uuid": "test-helper@local", "name": "test helper", "description": "test", "shell-version": ["$SHELL_MAJOR"]}
EOF
cat > "$EXT_DIR/test-helper@local/extension.js" <<'EOF'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class TestHelper extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
EOF

cat > "$TMP/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['test-helper@local', '$UUID']
disabled-extensions=['ding@rastersoft.com', 'snapd-prompting@canonical.com', 'snapd-search-provider@canonical.com', 'web-search-provider@ubuntu.com', 'ubuntu-appindicators@ubuntu.com', 'tiling-assistant@ubuntu.com']
welcome-dialog-last-shown-version='999'

[org/gnome/desktop/interface]
color-scheme='prefer-dark'

[org/gnome/desktop/notifications]
show-banners=false

[org/gnome/desktop/screensaver]
lock-enabled=false
EOF

# Barramentos D-Bus privados (sessão e um "sistema" falso), sem ativação de serviços.
for bus in session system; do
    cat > "$TMP/$bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$TMP/${bus}_bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
    BUS_PIDS+=("$(dbus-daemon --config-file="$TMP/$bus.conf" --fork --print-pid)")
done

MODE_ARGS=()
[[ -f /usr/share/gnome-shell/modes/ubuntu.json ]] && MODE_ARGS=(--mode=ubuntu)

# --- inicia o GNOME Shell headless -----------------------------------------------
env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${USER:-$(id -un)}" SHELL=/bin/bash \
    PATH=/usr/local/bin:/usr/bin:/bin LANG="${LANG:-C.UTF-8}" \
    XDG_RUNTIME_DIR="$TMP/runtime" XDG_DATA_HOME="$TMP/data" XDG_CONFIG_HOME="$TMP/config" \
    XDG_CACHE_HOME="$TMP/cache" XDG_STATE_HOME="$TMP/state" \
    XDG_DATA_DIRS=/usr/share/ubuntu:/usr/local/share:/usr/share \
    XDG_CURRENT_DESKTOP=ubuntu:GNOME XDG_SESSION_TYPE=wayland \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$TMP/session_bus" \
    DBUS_SYSTEM_BUS_ADDRESS="unix:path=$TMP/system_bus" \
    GSETTINGS_BACKEND=keyfile NO_AT_BRIDGE=1 GTK_A11Y=none PULSE_SERVER=unix:/nonexistent \
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1080 \
        --wayland-display "cgm-test-$$" "${MODE_ARGS[@]}" > "$LOG" 2>&1 &
SHELL_PID=$!

export DBUS_SESSION_BUS_ADDRESS="unix:path=$TMP/session_bus"
shell_eval() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}
screenshot() {
    gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$1" > /dev/null
}

echo "Iniciando $(gnome-shell --version) isolado..."
ready=0
for _ in $(seq 60); do
    if shell_eval '1+1' 2>/dev/null | grep -q "(true, '2')"; then
        ready=1
        break
    fi
    if ! kill -0 "$SHELL_PID" 2>/dev/null; then
        break
    fi
    sleep 0.5
done
if [[ $ready != 1 ]]; then
    echo "Falha ao iniciar o GNOME Shell. Últimas linhas de $LOG:" >&2
    tail -30 "$LOG" >&2
    exit 1
fi

# --- testes -----------------------------------------------------------------
shell_eval 'Main.overview.hide(); 1' > /dev/null
echo "Coletando dados por ${WAIT_SECONDS}s..."
sleep "$WAIT_SECONDS"
screenshot "$OUT/area-de-trabalho.png"

shell_eval "Main.panel.statusArea['$UUID']?.menu.open(0); 1" > /dev/null
sleep 0.5
screenshot "$OUT/menu.png"
shell_eval "Main.panel.statusArea['$UUID']?.menu.close(0); 1" > /dev/null

ext_info() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID"
}
ext_state() {
    grep -oE "'state': <[0-9.]+>" <<< "$(ext_info)" | grep -oE '[0-9]+' | head -1 || true
}

# --- testes funcionais ----------------------------------------------------------
# Usa os menus da extensão como uma pessoa usaria e confere o resultado por dentro do
# Shell. O JS vai pelo gdbus numa linha só: sem comentários "//" nem barras invertidas.
FAILS=()
act() { # act <js> [segundos]: executa uma ação e espera o Shell processá-la
    shell_eval "$1; 1" > /dev/null
    sleep "${2:-0.5}"
}
check() { # check <nome> <js>: o js devolve um objeto; o passo passa se ele tiver ok = true
    local result
    result="$(shell_eval "$2" 2>&1 || true)"
    if grep -q '"ok":true' <<< "$result"; then
        echo "  ok     $1"
    else
        echo "  FALHA  $1: $result"
        FAILS+=("$1")
    fi
}

if [[ "$(ext_state)" == "1" ]]; then
    echo "Testes funcionais:"
    # Funções auxiliares dos próximos passos, em globalThis.__kodo.
    act "$(tr '\n' ' ' <<'JS'
globalThis.__kodo = (() => {
    const uuid = 'kodo-cgpu@desktop.local';
    const lm = Main.layoutManager;
    const ext = () => Main.extensionManager.lookup(uuid);
    const ind = () => Main.panel.statusArea[uuid];
    const view = () => ext().stateObj._widget.view;
    const widgets = () => [lm._backgroundGroup, lm.uiGroup]
        .flatMap(g => g.get_children())
        .filter(a => String(a.style_class ?? '').includes('cgm-widget')).length;
    const where = () => {
        const p = view().get_parent();
        return !p ? 'hidden' : p === lm._backgroundGroup ? 'desktop' : p === lm.uiGroup ? 'above' : 'other';
    };
    const marked = items => [...items].filter(([, it]) => it._ornament === 1).map(([k]) => k).join();
    const stale = items => [...items]
        .filter(([, it]) => it._ornament !== 1 && /^ornament-dot(-checked)?-symbolic$/.test(it._ornamentIcon.icon_name ?? ''))
        .map(([k]) => k).join();
    const gaps = () => {
        const a = lm.getWorkAreaForMonitor(lm.primaryIndex);
        const [x, y] = view().get_position();
        const [w, h] = view().get_size();
        return {left: x - a.x, top: y - a.y, right: a.x + a.width - x - w, bottom: a.y + a.height - y - h};
    };
    return {ext, ind, widgets, where, marked, stale, gaps};
})()
JS
)"
    check "dados chegando (uso de CPU e RAM)" \
        "(() => { const k = globalThis.__kodo; const r = {cpu: k.ind()._cpuUsage.text, ram: k.ext().stateObj._sampler.ram.usage}; r.ok = r.cpu.endsWith('%') && typeof r.ram === 'number'; return r; })()"

    # Só um item do menu pode ficar marcado ("sobrando" = desmarcado mas ainda com a bolinha cheia).
    for mode in above hidden desktop; do
        act "globalThis.__kodo.ind()._modeItems.get('$mode').activate(null)"
        check "menu Widget: $mode" \
            "(() => { const k = globalThis.__kodo; const items = k.ind()._modeItems; const r = {lugar: k.where(), marcado: k.marked(items), sobrando: k.stale(items)}; r.ok = r.lugar === '$mode' && r.marcado === '$mode' && r.sobrando === ''; return r; })()"
    done

    for pos in bottom-right top-left; do
        act "globalThis.__kodo.ind()._positionItems.get('$pos').activate(null)"
        check "menu Posição: $pos" \
            "(() => { const k = globalThis.__kodo; const items = k.ind()._positionItems; const [v, h] = '$pos'.split('-'); const g = k.gaps(); const r = {margens: g, marcado: k.marked(items), sobrando: k.stale(items)}; r.ok = Math.abs(g[v] - g[h]) <= 1 && g[v] > 0 && g[v] < 100 && r.marcado === '$pos' && r.sobrando === ''; return r; })()"
    done

    act "globalThis.__kodo.ind()._textSwitch.toggle()"
    check "valores na barra: desligados" \
        "(() => { const i = globalThis.__kodo.ind(); const r = {valores: i._values.visible, icone: i._icon.visible}; r.ok = !r.valores && r.icone; return r; })()"
    act "globalThis.__kodo.ind()._textSwitch.toggle()"
    check "valores na barra: ligados" \
        "(() => { const i = globalThis.__kodo.ind(); const r = {valores: i._values.visible, icone: i._icon.visible}; r.ok = r.valores && !r.icone; return r; })()"

    # O GNOME desativa as extensões ao bloquear a tela e reativa ao desbloquear.
    act "Main.extensionManager.disableExtension('$UUID')" 1
    check "desativar remove tudo" \
        "(() => { const k = globalThis.__kodo; const r = {estado: k.ext().state, indicador: !!k.ind(), widgets: k.widgets(), coletorParado: k.ext().stateObj._sampler === null}; r.ok = r.estado === 2 && !r.indicador && r.widgets === 0 && r.coletorParado; return r; })()"
    act "Main.extensionManager.enableExtension('$UUID')" 1
    check "reativar recria tudo" \
        "(() => { const k = globalThis.__kodo; const r = {estado: k.ext().state, indicador: !!k.ind(), widgets: k.widgets()}; r.ok = r.estado === 1 && r.indicador && r.widgets === 1; return r; })()"
else
    echo "Testes funcionais pulados: a extensão não está ativa."
fi

info="$(ext_info)"
state="$(grep -oE "'state': <[0-9.]+>" <<< "$info" | grep -oE '[0-9]+' | head -1 || true)"
error="$(grep -oE "'error': <'[^']*'>" <<< "$info" | sed -E "s/'error': <'(.*)'>/\1/" || true)"
ext_log="$(grep -n -B2 -A8 "$UUID" "$LOG" || true)"

echo
echo "Capturas: $OUT/area-de-trabalho.png e $OUT/menu.png"
echo "Log:      $LOG"
if [[ "$state" == "1" && -z "$error" && -z "$ext_log" && ${#FAILS[@]} -eq 0 ]]; then
    echo "OK: $(gnome-shell --version), extensão ativa, sem erros e com todos os testes passando."
else
    echo "FALHA: estado=${state:-desconhecido} erro='${error}' testes com falha=${#FAILS[@]}" >&2
    [[ -n "$ext_log" ]] && echo "$ext_log" >&2
    exit 1
fi
