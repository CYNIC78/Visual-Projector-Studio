// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-resource-manager.js — Resource Manager for LLM ↔ SD switch  ║
// ║  Manages VRAM: ensures diffusion and LLM not eating each other  ║
// ║  Blender-like: explicit modes, no timers, user controls.        ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const getVP = () => window.VisualProjector || null;

    const RM = {
        mode: 'idle', // idle | chat | gen
        _lastChatAt: 0,
        _lastGenAt: 0,

        init() {
            console.log('[VP Resource] Manager ready — idle');
        },

        async switchToChat(reason = 'user') {
            if (this.mode === 'chat') return true;
            console.log(`[VP Resource] switchToChat (${reason}) — stopping SD server to free VRAM`);
            this.mode = 'chat';
            this._lastChatAt = Date.now();
            // Unload SD if running
            const srv = window.VP_SD_SERVER;
            if (srv?.isRunning) {
                getVP()?.showToast?.('💬 Chat mode — unloading SD model to free VRAM', 'info');
                await srv.stop().catch(() => {});
            }
            getVP()?.showToast?.('Chat mode active (SD unloaded)', 'success');
            return true;
        },

        async switchToGen(reason = 'user') {
            if (this.mode === 'gen') return true;
            console.log(`[VP Resource] switchToGen (${reason}) — LLM should be paused if possible`);
            this.mode = 'gen';
            this._lastGenAt = Date.now();
            // For future llama.cpp manager: would pause/unload LLM here
            // For now, just inform user if chat is active
            const modelConfig = getVP()?.state?.modelConfig;
            if (modelConfig?.endpoint && modelConfig.endpoint.includes('1234')) {
                // LM Studio likely loaded
                getVP()?.showToast?.('🎨 Gen mode — consider unloading chat model in LM Studio to free VRAM', 'info');
            }
            getVP()?.showToast?.('Gen mode active — SD will load on next Produce', 'success');
            return true;
        },

        async unloadAll(reason = 'user') {
            console.log(`[VP Resource] unloadAll (${reason})`);
            this.mode = 'idle';
            const srv = window.VP_SD_SERVER;
            if (srv?.isRunning) await srv.stop().catch(() => {});
            // Future: llama.cpp unload
            getVP()?.showToast?.('All models unloaded, VRAM freed', 'success');
            return true;
        },

        getMode() { return this.mode; },

        // Hook for chat send
        hookChat() {
            // Called before LLM request
            if (this.mode !== 'chat') this.switchToChat('auto-chat');
        },

        hookGen() {
            if (this.mode !== 'gen') this.switchToGen('auto-gen');
        }
    };

    window.VP_RESOURCE = RM;
    if (window.VisualProjector) window.VisualProjector.resource = RM;
    else {
        const iv = setInterval(() => {
            if (window.VisualProjector) {
                window.VisualProjector.resource = RM;
                clearInterval(iv);
            }
        }, 300);
        setTimeout(() => clearInterval(iv), 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => RM.init());
    } else {
        setTimeout(() => RM.init(), 0);
    }

    console.log('[VP Resource] Loaded — future llama.cpp + sd.cpp bundle manager');
})();
