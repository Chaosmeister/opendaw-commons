// Simple Sine: a polyphonic sine synth as a plain CLAP instrument, the smallest WebCLAP that makes sound.
// Sixteen voices, a linear attack and release, one gain parameter. No webview, the host shows its parameters.

#include <clap/clap.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define VOICES 16
#define PARAM_GAIN 0
#define ATTACK_SECONDS 0.005
#define RELEASE_SECONDS 0.25

void emscripten_notify_memory_growth(size_t index) {(void) index;}

typedef struct {
    int active;
    int key;
    int channel;
    int released;
    double phase;
    double increment;
    double level;
    double velocity;
} Voice;

typedef struct {
    clap_plugin_t plugin;
    const clap_host_t *host;
    double sample_rate;
    double gain;
    Voice voices[VOICES];
} Sine;

static const char *features[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, CLAP_PLUGIN_FEATURE_STEREO, NULL};

static const clap_plugin_descriptor_t descriptor = {
    .clap_version = CLAP_VERSION_INIT,
    .id = "studio.opendaw.commons.simple-sine",
    .name = "Simple Sine",
    .vendor = "openDAW Commons",
    .url = "https://github.com/andremichelle/opendaw-commons/tree/main/wclaps/simple-sine",
    .manual_url = "",
    .support_url = "",
    .version = "1.0.0",
    .description = "A polyphonic sine synth",
    .features = features
};

static void note_on(Sine *sine, int key, int channel, double velocity) {
    Voice *target = NULL;
    for (int i = 0; i < VOICES && target == NULL; i++) {if (!sine->voices[i].active) {target = &sine->voices[i];}}
    if (target == NULL) {target = &sine->voices[0];}
    target->active = 1;
    target->key = key;
    target->channel = channel;
    target->released = 0;
    target->phase = 0.0;
    target->level = 0.0;
    target->velocity = velocity;
    target->increment = 440.0 * pow(2.0, (key - 69) / 12.0) / sine->sample_rate;
}

static void note_off(Sine *sine, int key, int channel) {
    for (int i = 0; i < VOICES; i++) {
        Voice *voice = &sine->voices[i];
        if (voice->active && voice->key == key && (channel < 0 || voice->channel == channel)) {voice->released = 1;}
    }
}

static void handle_event(Sine *sine, const clap_event_header_t *header) {
    if (header->space_id != CLAP_CORE_EVENT_SPACE_ID) {return;}
    switch (header->type) {
        case CLAP_EVENT_NOTE_ON: {
            const clap_event_note_t *note = (const clap_event_note_t *) header;
            note_on(sine, note->key, note->channel, note->velocity);
            break;
        }
        case CLAP_EVENT_NOTE_OFF: {
            const clap_event_note_t *note = (const clap_event_note_t *) header;
            note_off(sine, note->key, note->channel);
            break;
        }
        case CLAP_EVENT_PARAM_VALUE: {
            const clap_event_param_value_t *param = (const clap_event_param_value_t *) header;
            if (param->param_id == PARAM_GAIN) {sine->gain = param->value;}
            break;
        }
        default:
            break;
    }
}

static void render(Sine *sine, float *left, float *right, uint32_t from, uint32_t to) {
    const double attack = 1.0 / (ATTACK_SECONDS * sine->sample_rate);
    const double release = 1.0 / (RELEASE_SECONDS * sine->sample_rate);
    for (uint32_t frame = from; frame < to; frame++) {
        double sum = 0.0;
        for (int i = 0; i < VOICES; i++) {
            Voice *voice = &sine->voices[i];
            if (!voice->active) {continue;}
            if (voice->released) {
                voice->level -= release;
                if (voice->level <= 0.0) {
                    voice->active = 0;
                    continue;
                }
            } else if (voice->level < 1.0) {
                voice->level = fmin(1.0, voice->level + attack);
            }
            sum += sin(voice->phase * 2.0 * M_PI) * voice->level * voice->velocity;
            voice->phase += voice->increment;
            if (voice->phase >= 1.0) {voice->phase -= 1.0;}
        }
        const float sample = (float) (sum * sine->gain * 0.25);
        left[frame] = sample;
        right[frame] = sample;
    }
}

static bool sine_init(const clap_plugin_t *plugin) {(void) plugin; return true;}

static void sine_destroy(const clap_plugin_t *plugin) {free(plugin->plugin_data);}

static bool sine_activate(const clap_plugin_t *plugin, double sample_rate, uint32_t min_frames, uint32_t max_frames) {
    (void) min_frames;
    (void) max_frames;
    ((Sine *) plugin->plugin_data)->sample_rate = sample_rate;
    return true;
}

static void sine_deactivate(const clap_plugin_t *plugin) {(void) plugin;}

static bool sine_start_processing(const clap_plugin_t *plugin) {(void) plugin; return true;}

static void sine_stop_processing(const clap_plugin_t *plugin) {(void) plugin;}

static void sine_reset(const clap_plugin_t *plugin) {
    Sine *sine = (Sine *) plugin->plugin_data;
    memset(sine->voices, 0, sizeof(sine->voices));
}

static clap_process_status sine_process(const clap_plugin_t *plugin, const clap_process_t *process) {
    Sine *sine = (Sine *) plugin->plugin_data;
    if (process->audio_outputs_count < 1 || process->audio_outputs[0].channel_count < 2) {return CLAP_PROCESS_ERROR;}
    float *left = process->audio_outputs[0].data32[0];
    float *right = process->audio_outputs[0].data32[1];
    const uint32_t frames = process->frames_count;
    const uint32_t count = process->in_events->size(process->in_events);
    uint32_t position = 0;
    for (uint32_t index = 0; index < count; index++) {
        const clap_event_header_t *header = process->in_events->get(process->in_events, index);
        const uint32_t time = header->time < frames ? header->time : frames;
        if (time > position) {
            render(sine, left, right, position, time);
            position = time;
        }
        handle_event(sine, header);
    }
    render(sine, left, right, position, frames);
    return CLAP_PROCESS_CONTINUE;
}

static uint32_t audio_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 0 : 1;}

static bool audio_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
    (void) plugin;
    if (is_input || index > 0) {return false;}
    info->id = 0;
    strcpy(info->name, "Output");
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->channel_count = 2;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

static const clap_plugin_audio_ports_t audio_ports = {.count = audio_ports_count, .get = audio_ports_get};

static uint32_t note_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 1 : 0;}

static bool note_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_note_port_info_t *info) {
    (void) plugin;
    if (!is_input || index > 0) {return false;}
    info->id = 0;
    info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
    info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
    strcpy(info->name, "Notes");
    return true;
}

static const clap_plugin_note_ports_t note_ports = {.count = note_ports_count, .get = note_ports_get};

static uint32_t params_count(const clap_plugin_t *plugin) {(void) plugin; return 1;}

static bool params_get_info(const clap_plugin_t *plugin, uint32_t index, clap_param_info_t *info) {
    (void) plugin;
    if (index > 0) {return false;}
    memset(info, 0, sizeof(*info));
    info->id = PARAM_GAIN;
    info->flags = CLAP_PARAM_IS_AUTOMATABLE;
    strcpy(info->name, "Gain");
    info->min_value = 0.0;
    info->max_value = 1.0;
    info->default_value = 0.8;
    return true;
}

static bool params_get_value(const clap_plugin_t *plugin, clap_id id, double *value) {
    if (id != PARAM_GAIN) {return false;}
    *value = ((Sine *) plugin->plugin_data)->gain;
    return true;
}

static bool params_value_to_text(const clap_plugin_t *plugin, clap_id id, double value, char *text, uint32_t size) {
    (void) plugin;
    if (id != PARAM_GAIN || size < 8) {return false;}
    const int percent = (int) lround(value * 100.0);
    const int digits = percent >= 100 ? 3 : percent >= 10 ? 2 : 1;
    for (int i = digits - 1, rest = percent; i >= 0; i--, rest /= 10) {text[i] = (char) ('0' + rest % 10);}
    text[digits] = '%';
    text[digits + 1] = '\0';
    return true;
}

static bool params_text_to_value(const clap_plugin_t *plugin, clap_id id, const char *text, double *value) {
    (void) plugin;
    if (id != PARAM_GAIN) {return false;}
    *value = fmin(1.0, fmax(0.0, atof(text) / 100.0));
    return true;
}

static void params_flush(const clap_plugin_t *plugin, const clap_input_events_t *in, const clap_output_events_t *out) {
    (void) out;
    Sine *sine = (Sine *) plugin->plugin_data;
    const uint32_t count = in->size(in);
    for (uint32_t index = 0; index < count; index++) {handle_event(sine, in->get(in, index));}
}

static const clap_plugin_params_t params = {
    .count = params_count,
    .get_info = params_get_info,
    .get_value = params_get_value,
    .value_to_text = params_value_to_text,
    .text_to_value = params_text_to_value,
    .flush = params_flush
};

static const void *sine_get_extension(const clap_plugin_t *plugin, const char *id) {
    (void) plugin;
    if (strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0) {return &audio_ports;}
    if (strcmp(id, CLAP_EXT_NOTE_PORTS) == 0) {return &note_ports;}
    if (strcmp(id, CLAP_EXT_PARAMS) == 0) {return &params;}
    return NULL;
}

static void sine_on_main_thread(const clap_plugin_t *plugin) {(void) plugin;}

static const clap_plugin_t *create(const clap_plugin_factory_t *factory, const clap_host_t *host, const char *plugin_id) {
    (void) factory;
    if (strcmp(plugin_id, descriptor.id) != 0) {return NULL;}
    Sine *sine = (Sine *) calloc(1, sizeof(Sine));
    if (sine == NULL) {return NULL;}
    sine->host = host;
    sine->sample_rate = 48000.0;
    sine->gain = 0.8;
    sine->plugin.desc = &descriptor;
    sine->plugin.plugin_data = sine;
    sine->plugin.init = sine_init;
    sine->plugin.destroy = sine_destroy;
    sine->plugin.activate = sine_activate;
    sine->plugin.deactivate = sine_deactivate;
    sine->plugin.start_processing = sine_start_processing;
    sine->plugin.stop_processing = sine_stop_processing;
    sine->plugin.reset = sine_reset;
    sine->plugin.process = sine_process;
    sine->plugin.get_extension = sine_get_extension;
    sine->plugin.on_main_thread = sine_on_main_thread;
    return &sine->plugin;
}

static uint32_t plugin_count(const clap_plugin_factory_t *factory) {(void) factory; return 1;}

static const clap_plugin_descriptor_t *plugin_descriptor(const clap_plugin_factory_t *factory, uint32_t index) {
    (void) factory;
    return index == 0 ? &descriptor : NULL;
}

static const clap_plugin_factory_t factory = {
    .get_plugin_count = plugin_count,
    .get_plugin_descriptor = plugin_descriptor,
    .create_plugin = create
};

static bool entry_init(const char *path) {(void) path; return true;}

static void entry_deinit(void) {}

static const void *entry_get_factory(const char *id) {
    return strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : NULL;
}

CLAP_EXPORT const clap_plugin_entry_t clap_entry = {
    .clap_version = CLAP_VERSION_INIT,
    .init = entry_init,
    .deinit = entry_deinit,
    .get_factory = entry_get_factory
};
