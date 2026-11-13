// Kodō (鼓動) — Monitor de CPU e GPU
//
// Widget fixo na área de trabalho + indicador na barra superior do GNOME Shell.
// Fontes de dados:
//   - CPU: /proc/stat (uso), /proc/cpuinfo (frequência), hwmon k10temp (temperatura),
//          hwmon amdgpu "PPT" do gráfico integrado (potência do soquete, só em AMD)
//   - GPU: nvidia-smi em modo contínuo (um único processo, sem custo de reinicialização)
//   - RAM: /proc/meminfo
// Todas as leituras de arquivo são assíncronas para nunca travar a interface.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UPDATE_SECONDS = 2;
const HISTORY_LENGTH = 60; // 60 amostras x 2 s = 2 minutos de histórico nos gráficos
const WIDGET_MARGIN = 16;
const GPU_STALE_US = 3 * UPDATE_SECONDS * GLib.USEC_PER_SEC;
const DIM = 150; // opacidade (0-255) dos textos secundários

const COLORS = {
    cpu: [0.384, 0.627, 0.918], // #62a0ea
    gpu: [0.200, 0.820, 0.478], // #33d17a
    ram: [0.753, 0.380, 0.796], // #c061cb
};

// Faixas (°C) para colorir as temperaturas: verde, amarelo a partir de "warm", vermelho a partir de "hot".
const CPU_TEMP_LIMITS = {warm: 75, hot: 88}; // Ryzen 7000 trabalha até 95 °C por projeto
const GPU_TEMP_LIMITS = {warm: 72, hot: 83};

const MODES = [
    ['desktop', 'Na área de trabalho (atrás das janelas)', 'área de trabalho'],
    ['above', 'Sempre visível (sobre as janelas)', 'sempre visível'],
    ['hidden', 'Oculto', 'oculto'],
];

const POSITIONS = [
    ['top-left', 'Canto superior esquerdo', 'superior esquerdo'],
    ['top-right', 'Canto superior direito', 'superior direito'],
    ['bottom-left', 'Canto inferior esquerdo', 'inferior esquerdo'],
    ['bottom-right', 'Canto inferior direito', 'inferior direito'],
];

const decoder = new TextDecoder();

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const fileExists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

function toNumber(text, divisor = 1) {
    if (text === null || text === undefined)
        return null;
    const n = parseFloat(text);
    return Number.isFinite(n) ? n / divisor : null;
}

function readFileSync(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

function readFile(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                const [, bytes] = file.load_contents_finish(res);
                resolve(decoder.decode(bytes));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function formatDecimal(value, digits) {
    return value.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

const formatPercent = v => (isNum(v) ? `${Math.round(v)}%` : '—');
const formatTemp = v => (isNum(v) ? `${Math.round(v)} °C` : '—');
const formatTempShort = v => (isNum(v) ? `${Math.round(v)}°` : '—');
const formatWatts = v => (isNum(v) ? `${Math.round(v)} W` : '—');

function tempLevel(value, limits) {
    if (!isNum(value))
        return null;
    if (value >= limits.hot)
        return 'hot';
    return value >= limits.warm ? 'warm' : 'ok';
}

function setLevel(actor, level) {
    if (actor._cgmLevel === level)
        return;
    if (actor._cgmLevel)
        actor.remove_style_class_name(`cgm-level-${actor._cgmLevel}`);
    if (level)
        actor.add_style_class_name(`cgm-level-${level}`);
    actor._cgmLevel = level;
}

function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}

function pushHistory(history, value) {
    history.push(value);
    if (history.length > HISTORY_LENGTH)
        history.splice(0, history.length - HISTORY_LENGTH);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/* ------------------------------------------------------------------ */
/* Descoberta de sensores                                              */
/* ------------------------------------------------------------------ */

function cpuModelName() {
    const match = (readFileSync('/proc/cpuinfo') ?? '').match(/^model name\s*:\s*(.+)$/m);
    if (!match)
        return 'Processador';
    return match[1]
        .replace(/\((R|TM)\)/gi, '')
        .replace(/\s+\d+-Core Processor.*$/i, '')
        .replace(/\s+Processor.*$/i, '')
        .replace(/\s+CPU\s+@.*$/i, '')
        .replace(/\s+w(ith|\/)\s*Radeon.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function listHwmons() {
    const base = '/sys/class/hwmon';
    const result = [];
    try {
        const children = Gio.File.new_for_path(base).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            const path = `${base}/${info.get_name()}`;
            const name = readFileSync(`${path}/name`)?.trim();
            if (name)
                result.push({name, path});
        }
        children.close(null);
    } catch (e) {
        console.warn(`[kodo-cgpu] hwmon: ${e.message}`);
    }
    return result;
}

// Procura o arquivo <kind>N_input cujo <kind>N_label está em `labels` (em ordem de preferência).
function findSensor(path, kind, labels) {
    const byLabel = new Map();
    for (let i = 1; i <= 16; i++) {
        const label = readFileSync(`${path}/${kind}${i}_label`)?.trim();
        if (label)
            byLabel.set(label, `${path}/${kind}${i}_input`);
    }
    for (const label of labels) {
        if (byLabel.has(label))
            return byLabel.get(label);
    }
    return null;
}

function discoverSensors(cpuModel) {
    const hwmons = listHwmons();

    let cpuTemp = null;
    const candidates = [
        ['k10temp', ['Tdie', 'Tctl']],
        ['zenpower', ['Tdie', 'Tctl']],
        ['coretemp', ['Package id 0']],
        ['cpu_thermal', []],
        ['acpitz', []],
    ];
    for (const [name, labels] of candidates) {
        for (const hwmon of hwmons.filter(h => h.name === name)) {
            cpuTemp = findSensor(hwmon.path, 'temp', labels);
            if (!cpuTemp && fileExists(`${hwmon.path}/temp1_input`))
                cpuTemp = `${hwmon.path}/temp1_input`;
            if (cpuTemp)
                break;
        }
        if (cpuTemp)
            break;
    }

    // Em processadores AMD com gráfico integrado (ex.: Ryzen 7000), o sensor "PPT"
    // do amdgpu integrado (sem ventoinha) informa a potência total do soquete da CPU.
    let cpuPower = null;
    if (/AMD/i.test(cpuModel)) {
        for (const hwmon of hwmons.filter(h => h.name === 'amdgpu')) {
            if (fileExists(`${hwmon.path}/fan1_input`))
                continue; // placa de vídeo dedicada, não é a CPU
            cpuPower = findSensor(hwmon.path, 'power', ['PPT']);
            if (cpuPower)
                break;
        }
    }

    return {cpuTemp, cpuPower};
}

/* ------------------------------------------------------------------ */
/* GPU NVIDIA: um processo nvidia-smi em modo contínuo                 */
/* ------------------------------------------------------------------ */

class NvidiaSmi {
    constructor() {
        this.available = GLib.find_program_in_path('nvidia-smi') !== null;
        this._data = null;
        this._time = 0;
        this._failures = 0;
        this._proc = null;
        this._cancellable = null;
        this._restartId = 0;
    }

    start() {
        if (this.available)
            this._spawn();
    }

    stop() {
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._proc?.force_exit();
        this._proc = null;
    }

    // Última leitura recebida, ou null se não houver dado recente.
    latest() {
        if (!this._data || GLib.get_monotonic_time() - this._time > GPU_STALE_US)
            return null;
        return this._data;
    }

    _spawn() {
        let proc;
        try {
            proc = Gio.Subprocess.new([
                'nvidia-smi', '-i', '0',
                '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,name',
                '--format=csv,noheader,nounits',
                '-lms', `${UPDATE_SECONDS * 1000}`,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`[kodo-cgpu] nvidia-smi: ${e.message}`);
            this._scheduleRestart();
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._proc = proc;
        this._cancellable = cancellable;

        const stream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLine(stream, cancellable);

        proc.wait_async(cancellable, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {
                return; // cancelado: a extensão foi desativada
            }
            if (this._proc !== p)
                return;
            // O nvidia-smi terminou sozinho (ex.: driver recarregado): tenta de novo.
            this._proc = null;
            this._cancellable = null;
            cancellable.cancel();
            this._scheduleRestart();
        });
    }

    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_LOW, cancellable, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null)
                return; // fim da saída; o wait_async cuida do reinício
            this._parse(line);
            this._readLine(s, cancellable);
        });
    }

    _parse(line) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 6)
            return;
        this._data = {
            usage: toNumber(parts[0]),
            temp: toNumber(parts[1]),
            memUsed: toNumber(parts[2]), // MiB
            memTotal: toNumber(parts[3]), // MiB
            power: toNumber(parts[4]), // W
            name: parts.slice(5).join(', '),
        };
        this._time = GLib.get_monotonic_time();
        this._failures = 0;
    }

    _scheduleRestart() {
        if (this._restartId)
            return;
        this._failures++;
        const delay = Math.min(60, 5 * this._failures);
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, delay, () => {
            this._restartId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }
}

/* ------------------------------------------------------------------ */
/* Coleta periódica                                                    */
/* ------------------------------------------------------------------ */

class Sampler {
    constructor() {
        const model = cpuModelName();
        this.cpu = {model, usage: null, temp: null, freq: null, power: null, history: []};
        this.gpu = {
            name: null, usage: null, temp: null, memUsed: null, memTotal: null, power: null,
            history: [], status: 'loading',
        };
        this.ram = {used: null, total: null, usage: null};

        this._sensors = discoverSensors(model);
        this._nvidia = new NvidiaSmi();
        this._prevCpu = null;
        this._ticks = 0;
        this._listeners = [];
        this._cancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._busy = false;
    }

    addListener(callback) {
        this._listeners.push(callback);
    }

    start() {
        this._nvidia.start();
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UPDATE_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._cancellable.cancel();
        this._nvidia.stop();
        this._listeners = [];
    }

    async _tick() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            await this._sample();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`[kodo-cgpu] ${e.message}`);
        } finally {
            this._busy = false;
        }

        if (this._cancellable.is_cancelled())
            return;
        for (const listener of this._listeners) {
            try {
                listener(this);
            } catch (e) {
                console.error(e);
            }
        }
    }

    async _sample() {
        const cancellable = this._cancellable;
        const optional = path => (path ? readFile(path, cancellable).catch(() => null) : null);
        const [stat, meminfo, cpuinfo, tempText, powerText] = await Promise.all([
            readFile('/proc/stat', cancellable),
            readFile('/proc/meminfo', cancellable),
            optional('/proc/cpuinfo'),
            optional(this._sensors.cpuTemp),
            optional(this._sensors.cpuPower),
        ]);
        this._ticks++;

        // Uso de CPU: diferença entre duas leituras da linha "cpu" de /proc/stat.
        const fields = stat.slice(0, stat.indexOf('\n')).trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = fields[3] + fields[4];
        const total = fields.reduce((a, b) => a + b, 0);
        if (this._prevCpu && total > this._prevCpu.total) {
            const busy = 1 - (idle - this._prevCpu.idle) / (total - this._prevCpu.total);
            this.cpu.usage = clamp(100 * busy, 0, 100);
        }
        this._prevCpu = {idle, total};

        this.cpu.temp = toNumber(tempText, 1000); // m°C -> °C
        this.cpu.power = toNumber(powerText, 1e6); // µW -> W
        const mhz = cpuinfo
            ? [...cpuinfo.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map(m => parseFloat(m[1]))
            : [];
        this.cpu.freq = mhz.length ? mhz.reduce((a, b) => a + b, 0) / mhz.length : null;

        const kb = key => toNumber(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
        const memTotal = kb('MemTotal');
        const memAvailable = kb('MemAvailable');
        if (memTotal && isNum(memAvailable)) {
            this.ram.total = memTotal * 1024;
            this.ram.used = (memTotal - memAvailable) * 1024;
            this.ram.usage = 100 * this.ram.used / this.ram.total;
        }

        const gpu = this._nvidia.latest();
        this.gpu.usage = gpu?.usage ?? null;
        this.gpu.temp = gpu?.temp ?? null;
        this.gpu.memUsed = gpu?.memUsed ?? null;
        this.gpu.memTotal = gpu?.memTotal ?? null;
        this.gpu.power = gpu?.power ?? null;
        if (gpu?.name)
            this.gpu.name = gpu.name;
        if (!this._nvidia.available)
            this.gpu.status = 'missing';
        else if (gpu)
            this.gpu.status = 'ok';
        else if (this._ticks > 3)
            this.gpu.status = 'error';

        pushHistory(this.cpu.history, this.cpu.usage ?? 0);
        pushHistory(this.gpu.history, this.gpu.usage ?? 0);
    }
}

/* ------------------------------------------------------------------ */
/* Componentes visuais                                                 */
/* ------------------------------------------------------------------ */

const UsageGraph = GObject.registerClass(
class UsageGraph extends St.DrawingArea {
    _init(color) {
        super._init({style_class: 'cgm-graph', x_expand: true});
        this._color = color;
        this._values = [];
    }

    setValues(values) {
        this._values = values;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const [r, g, b] = this._color;
        try {
            roundedRect(cr, 0, 0, width, height, 7);
            cr.clip();
            cr.setSourceRGBA(1, 1, 1, 0.05);
            cr.paint();

            cr.setLineWidth(1);
            cr.setSourceRGBA(1, 1, 1, 0.07);
            for (const f of [0.25, 0.5, 0.75]) {
                const y = Math.round(height * f) + 0.5;
                cr.moveTo(0, y);
                cr.lineTo(width, y);
            }
            cr.stroke();

            const values = this._values;
            if (values.length < 2)
                return;
            const step = width / (HISTORY_LENGTH - 1);
            const x0 = width - (values.length - 1) * step;
            const yOf = v => height - 1 - (clamp(v, 0, 100) / 100) * (height - 3);

            cr.moveTo(x0, height);
            values.forEach((v, i) => cr.lineTo(x0 + i * step, yOf(v)));
            cr.lineTo(width, height);
            cr.closePath();
            const gradient = new Cairo.LinearGradient(0, 0, 0, height);
            gradient.addColorStopRGBA(0, r, g, b, 0.55);
            gradient.addColorStopRGBA(1, r, g, b, 0.08);
            cr.setSource(gradient);
            cr.fill();

            values.forEach((v, i) => {
                if (i === 0)
                    cr.moveTo(x0, yOf(v));
                else
                    cr.lineTo(x0 + i * step, yOf(v));
            });
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }
});

const LevelBar = GObject.registerClass(
class LevelBar extends St.DrawingArea {
    _init(color) {
        super._init({style_class: 'cgm-bar', x_expand: true});
        this._color = color;
        this._value = 0;
    }

    setValue(value) {
        this._value = isNum(value) ? clamp(value, 0, 100) : 0;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const [r, g, b] = this._color;
        try {
            roundedRect(cr, 0, 0, width, height, height / 2);
            cr.setSourceRGBA(1, 1, 1, 0.08);
            cr.fill();
            if (this._value > 0) {
                roundedRect(cr, 0, 0, Math.max(height, width * this._value / 100), height, height / 2);
                cr.setSourceRGBA(r, g, b, 1);
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }
});

// Bloco de um dispositivo: título, valor grande, gráfico/barra e linha de estatísticas.
const Section = GObject.registerClass(
class Section extends St.BoxLayout {
    _init({title, key, color, captions = [], graph = false, bar = false}) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `cgm-section cgm-${key}`,
            x_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'cgm-header', x_expand: true});
        const titles = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titles.add_child(new St.Label({text: title, style_class: 'cgm-title'}));
        this._subtitle = new St.Label({text: '', style_class: 'cgm-subtitle', opacity: DIM});
        titles.add_child(this._subtitle);
        header.add_child(titles);
        this._value = new St.Label({text: '—', style_class: 'cgm-value', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._value);
        this.add_child(header);

        if (graph) {
            this._graph = new UsageGraph(color);
            this.add_child(this._graph);
        }
        if (bar) {
            this._bar = new LevelBar(color);
            this.add_child(this._bar);
        }

        this._stats = [];
        if (captions.length) {
            const row = new St.BoxLayout({style_class: 'cgm-stats', x_expand: true});
            row.get_layout_manager().homogeneous = true;
            for (const caption of captions) {
                const chip = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    style_class: 'cgm-chip',
                    x_expand: true,
                });
                chip.add_child(new St.Label({text: caption, style_class: 'cgm-chip-caption', opacity: DIM}));
                const value = new St.Label({text: '—', style_class: 'cgm-chip-value'});
                chip.add_child(value);
                row.add_child(chip);
                this._stats.push(value);
            }
            this.add_child(row);
        }
    }

    setSubtitle(text) {
        setText(this._subtitle, text);
    }

    setValue(text) {
        setText(this._value, text);
    }

    setHistory(values) {
        this._graph?.setValues(values);
    }

    setBar(value) {
        this._bar?.setValue(value);
    }

    setStat(index, text, level = null) {
        setText(this._stats[index], text);
        setLevel(this._stats[index], level);
    }
});

// Painel completo (CPU, GPU, RAM). Usado no widget e no menu da barra superior.
const MonitorView = GObject.registerClass(
class MonitorView extends St.BoxLayout {
    _init(styleClass) {
        super._init({orientation: Clutter.Orientation.VERTICAL, style_class: `cgm-view ${styleClass}`});

        this._cpu = new Section({
            title: 'CPU', key: 'cpu', color: COLORS.cpu, graph: true,
            captions: ['TEMPERATURA', 'FREQUÊNCIA', 'POTÊNCIA'],
        });
        this._gpu = new Section({
            title: 'GPU', key: 'gpu', color: COLORS.gpu, graph: true,
            captions: ['TEMPERATURA', 'VRAM', 'POTÊNCIA'],
        });
        this._ram = new Section({title: 'MEMÓRIA RAM', key: 'ram', color: COLORS.ram, bar: true});

        this.add_child(this._cpu);
        this.add_child(new St.Widget({style_class: 'cgm-separator', x_expand: true}));
        this.add_child(this._gpu);
        this.add_child(new St.Widget({style_class: 'cgm-separator', x_expand: true}));
        this.add_child(this._ram);
    }

    update({cpu, gpu, ram}) {
        this._cpu.setSubtitle(cpu.model);
        this._cpu.setValue(formatPercent(cpu.usage));
        this._cpu.setHistory(cpu.history);
        this._cpu.setStat(0, formatTemp(cpu.temp), tempLevel(cpu.temp, CPU_TEMP_LIMITS));
        this._cpu.setStat(1, isNum(cpu.freq) ? `${formatDecimal(cpu.freq / 1000, 2)} GHz` : '—');
        this._cpu.setStat(2, formatWatts(cpu.power));

        const gpuSubtitle = {
            ok: gpu.name,
            loading: 'Carregando…',
            error: 'GPU indisponível (nvidia-smi falhou)',
            missing: 'nvidia-smi não encontrado',
        }[gpu.status];
        this._gpu.setSubtitle(gpuSubtitle ?? '');
        this._gpu.setValue(formatPercent(gpu.usage));
        this._gpu.setHistory(gpu.history);
        this._gpu.setStat(0, formatTemp(gpu.temp), tempLevel(gpu.temp, GPU_TEMP_LIMITS));
        this._gpu.setStat(1, isNum(gpu.memUsed) && isNum(gpu.memTotal)
            ? `${formatDecimal(gpu.memUsed / 1024, 1)}/${Math.round(gpu.memTotal / 1024)} GB`
            : '—');
        this._gpu.setStat(2, formatWatts(gpu.power));

        this._ram.setSubtitle(isNum(ram.used)
            ? `${formatDecimal(ram.used / 2 ** 30, 1)} de ${formatDecimal(ram.total / 2 ** 30, 1)} GB em uso`
            : '');
        this._ram.setValue(formatPercent(ram.usage));
        this._ram.setBar(ram.usage);
    }
});

/* ------------------------------------------------------------------ */
/* Widget da área de trabalho                                          */
/* ------------------------------------------------------------------ */

class DesktopWidget {
    constructor(settings) {
        this._settings = settings;
        this._mode = null;
        this.view = new MonitorView('cgm-widget');

        this.view.connectObject(
            'notify::width', () => this._reposition(),
            'notify::height', () => this._reposition(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        global.display.connectObject('workareas-changed', () => this._reposition(), this);
        Main.overview.connectObject(
            'showing', () => this._onOverview(true),
            'hiding', () => this._onOverview(false),
            this);
        settings.connectObject(
            'changed::widget-mode', () => this._applyMode(),
            'changed::widget-position', () => this._reposition(),
            this);

        this._applyMode();
    }

    update(sampler) {
        if (this._mode !== 'hidden')
            this.view.update(sampler);
    }

    _applyMode() {
        const mode = this._settings.get_string('widget-mode');
        this._detach();
        this.view.remove_all_transitions();
        this.view.opacity = 255;
        this.view.show();
        if (mode === 'desktop') {
            // Mesma camada do papel de parede: fica atrás de todas as janelas.
            Main.layoutManager._backgroundGroup.add_child(this.view);
        } else if (mode === 'above') {
            // Sobre as janelas. Não captura cliques (o widget não é "reactive") e
            // some quando há janela em tela cheia e durante a visão geral.
            Main.layoutManager.addChrome(this.view, {trackFullscreen: true});
            if (Main.overview.visible)
                this.view.opacity = 0;
        }
        this._mode = mode;
        this._reposition();
    }

    _detach() {
        const parent = this.view.get_parent();
        if (parent === Main.layoutManager.uiGroup)
            Main.layoutManager.removeChrome(this.view);
        else
            parent?.remove_child(this.view);
        this._mode = null;
    }

    _onOverview(showing) {
        if (this._mode !== 'above')
            return;
        this.view.remove_all_transitions();
        this.view.ease({opacity: showing ? 0 : 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _reposition() {
        if (!this.view.get_parent())
            return;
        const index = Main.layoutManager.primaryIndex;
        if (index < 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        const [width, height] = this.view.get_size();
        const margin = WIDGET_MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const position = this._settings.get_string('widget-position');
        const x = position.endsWith('left') ? area.x + margin : area.x + area.width - width - margin;
        const y = position.startsWith('top') ? area.y + margin : area.y + area.height - height - margin;
        this.view.set_position(Math.round(x), Math.round(y));
    }

    destroy() {
        this.view.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._detach();
        this.view.destroy();
        this.view = null;
    }
}

/* ------------------------------------------------------------------ */
/* Indicador da barra superior                                         */
/* ------------------------------------------------------------------ */

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.5, 'Kodō — Monitor de CPU e GPU');
        this._settings = settings;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box cgm-panel'});
        this._icon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            fallback_icon_name: 'power-profile-performance-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._icon);

        this._values = new St.BoxLayout({style_class: 'cgm-panel-values'});
        const label = (text, styleClass, opacity = 255) => {
            const l = new St.Label({text, style_class: styleClass, opacity, y_align: Clutter.ActorAlign.CENTER});
            this._values.add_child(l);
            return l;
        };
        label('CPU', 'cgm-panel-caption', 190);
        this._cpuUsage = label('—', 'cgm-panel-value cgm-panel-pct');
        this._cpuTemp = label('—', 'cgm-panel-value cgm-panel-temp');
        label('GPU', 'cgm-panel-caption cgm-panel-gap', 190);
        this._gpuUsage = label('—', 'cgm-panel-value cgm-panel-pct');
        this._gpuTemp = label('—', 'cgm-panel-value cgm-panel-temp');
        box.add_child(this._values);
        this.add_child(box);

        // Menu: painel completo + opções
        this._view = new MonitorView('cgm-menu-view');
        const viewSection = new PopupMenu.PopupMenuSection();
        viewSection.actor.add_child(this._view);
        this.menu.addMenuItem(viewSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._modeMenu = new PopupMenu.PopupSubMenuMenuItem('');
        this._modeItems = new Map();
        for (const [mode, text] of MODES) {
            const item = new PopupMenu.PopupMenuItem(text);
            item.connect('activate', () => this._settings.set_string('widget-mode', mode));
            this._modeMenu.menu.addMenuItem(item);
            this._modeItems.set(mode, item);
        }
        this.menu.addMenuItem(this._modeMenu);

        this._positionMenu = new PopupMenu.PopupSubMenuMenuItem('');
        this._positionItems = new Map();
        for (const [position, text] of POSITIONS) {
            const item = new PopupMenu.PopupMenuItem(text);
            item.connect('activate', () => this._settings.set_string('widget-position', position));
            this._positionMenu.menu.addMenuItem(item);
            this._positionItems.set(position, item);
        }
        this.menu.addMenuItem(this._positionMenu);

        this._textSwitch = new PopupMenu.PopupSwitchMenuItem('Mostrar valores na barra superior', true);
        this._textSwitch.connect('toggled', (_item, state) => {
            if (this._settings.get_boolean('show-panel-text') !== state)
                this._settings.set_boolean('show-panel-text', state);
        });
        this.menu.addMenuItem(this._textSwitch);

        this._settings.connectObject('changed', () => this._syncSettings(), this);
        this._syncSettings();
    }

    _syncSettings() {
        const mode = this._settings.get_string('widget-mode');
        for (const [m, item] of this._modeItems)
            item.setOrnament(m === mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        this._modeMenu.label.text = `Widget: ${MODES.find(m => m[0] === mode)?.[2] ?? mode}`;

        const position = this._settings.get_string('widget-position');
        for (const [p, item] of this._positionItems)
            item.setOrnament(p === position ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        this._positionMenu.label.text = `Posição: ${POSITIONS.find(p => p[0] === position)?.[2] ?? position}`;
        this._positionMenu.visible = mode !== 'hidden';

        const showText = this._settings.get_boolean('show-panel-text');
        this._textSwitch.setToggleState(showText);
        this._values.visible = showText;
        this._icon.visible = !showText;
    }

    update(sampler) {
        const {cpu, gpu} = sampler;
        setText(this._cpuUsage, formatPercent(cpu.usage));
        setText(this._cpuTemp, formatTempShort(cpu.temp));
        setText(this._gpuUsage, formatPercent(gpu.usage));
        setText(this._gpuTemp, formatTempShort(gpu.temp));
        // Na barra superior, só destaca temperaturas altas.
        const level = (v, limits) => (tempLevel(v, limits) === 'ok' ? null : tempLevel(v, limits));
        setLevel(this._cpuTemp, level(cpu.temp, CPU_TEMP_LIMITS));
        setLevel(this._gpuTemp, level(gpu.temp, GPU_TEMP_LIMITS));
        this._view.update(sampler);
    }

    destroy() {
        this._settings.disconnectObject(this);
        super.destroy();
    }
});

/* ------------------------------------------------------------------ */
/* Extensão                                                            */
/* ------------------------------------------------------------------ */

export default class KodoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sampler = new Sampler();
        this._widget = new DesktopWidget(this._settings);
        this._indicator = new Indicator(this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._sampler.addListener(sampler => {
            this._widget.update(sampler);
            this._indicator.update(sampler);
        });
        this._sampler.start();
    }

    disable() {
        this._sampler?.stop();
        this._sampler = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._widget?.destroy();
        this._widget = null;
        this._settings = null;
    }
}
