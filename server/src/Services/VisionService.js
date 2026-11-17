import axios from 'axios';
import { normalizeUrl } from '../Utils/url.js';
import { noopLogger } from '../Utils/logger.js';

/**
 * Vision service for describing images via a vision-capable model
 * (OpenAI-compatible API or Ollama).
 *
 * Wird wie das Chat-Modell konfiguriert (gleicher Endpunkt, anderes Modell).
 */
class VisionService {
    /**
     * @param {object} [params] - Configuration parameters
     * @param {string} [params.api='ollama'] - Vision API backend (openai/ollama)
     * @param {string} [params.url=''] - Vision server base URL
     * @param {string} [params.model=''] - Vision model name
     * @param {Logger} [params.logger] - Logger instance
     */
    constructor({ api = 'ollama', url = '', model = '', logger } = {}) {
        this.config = {
            api: (api === 'openai') ? 'openai' : 'ollama',
            baseUrl: normalizeUrl(url),
            modelName: model
        };
        this.label = '[Vision]';
        this.logger = logger || noopLogger();
    }

    /**
     * Aktualisiert die Runtime-Konfiguration (z. B. nach einer Settings-Änderung).
     * @param {object} cfg - { api, url, model }
     */
    updateConfig(cfg = {}) {
        this.config = {
            api: (cfg.api === 'openai') ? 'openai' : 'ollama',
            baseUrl: normalizeUrl(cfg.url || ''),
            modelName: cfg.model || ''
        };
    }

    /**
     * Extrahiert die Base64-Payload aus einem Data-URL (sonst unverändert).
     * @param {string} image
     * @returns {string}
     */
    static toBase64(image) {
        if (typeof image !== 'string') return image;
        const m = image.match(/^data:[^,]*,(.*)$/s);
        return m ? m[1] : image;
    }

    /**
     * Sendet Bild + Prompt an das Vision-Modell und liefert den Text zurück.
     * @param {string} image - Bild-URL oder Base64 / Data-URL
     * @param {string} [prompt='Describe this image.'] - Prompt für das Modell
     * @param {object} [options={}] - Zusätzliche Optionen (z. B. model, temperature)
     * @returns {Promise<string>} Text-Antwort des Modells
     */
    async describe(image, prompt = 'Describe this image.', options = {}) {
        const cfg = this.config;
        const base = normalizeUrl(cfg.baseUrl);
        const model = options.model || cfg.modelName;
        const extra = {};
        if (options.temperature !== undefined) extra.temperature = options.temperature;

        try {
            if (cfg.api === 'openai') {
                const res = await axios.post(`${base}/chat/completions`, {
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                { type: 'image_url', image_url: { url: image } }
                            ]
                        }
                    ],
                    ...extra
                });
                return res.data.choices?.[0]?.message?.content ?? '';
            }

            const res = await axios.post(`${base}/api/chat`, {
                model,
                messages: [
                    { role: 'user', content: prompt, images: [VisionService.toBase64(image)] }
                ],
                stream: false,
                ...extra
            });
            return res.data.message?.content ?? '';
        } catch (error) {
            this.logger.error(this.label, 'Failed to describe image:', error);
            throw error;
        }
    }
}

export { VisionService };
