//
// This is a big ole' collection of imported PNGs that have been
// packed up for us by webpack. I wouldn't normally do it this way
// but its worked out ok.
//

import { Game } from "src/Game";
import { GraphicsImage } from "./Graphics";

function importAll(r: any) {
    let images: any = {};

    r.keys().map((item: any, index: any) => {
        images[item.replace('./', '')] = r(item).default;
    });
    return images;
}

export const RESOURCES = importAll(require.context('../', true, /.{3}.(png|mp3)$/));

const params = new URLSearchParams(location.search);
const HEADLESS = params.get("headless") === "true";;

/** A list of all the reported errors for resources so we only show them once */
const reportedErrors: Record<string, boolean> = {};

/** The collection of all sprites loaded by the game */
export const SPRITES: Record<string, GraphicsImage> = {};
/** Date/Time of last time SPRITES were added */
export let LAST_SPRITES_UPDATE: number = Date.now();

/** The collection of all sound effects loaded by the game */
const sfx: Record<string, ArrayBuffer> = {};
/** The audio elements changed to sources for the audio context */
const audioBuffers: Record<string, AudioBuffer> = {};

/** The number of assets left to load */
let loadedCount = 0;
/** The last time each of the sound effects were played to prevent cycling */
const lastPlayed: Record<string, number> = {};

/**
 * Load a sprite into the resources cache
 * 
 * @param name The name to give the sprite in the cache
 * @param resource The path to the resource
 * @returns The newly created image/sprite
 */
function loadImage(name: string, resource: string): GraphicsImage {
    const image = new GraphicsImage(name, new Image());
    SPRITES[name] = image;
    image.get().src = RESOURCES[resource];
    image.get().onload = () => { loadedCount--; };
    loadedCount++;
    LAST_SPRITES_UPDATE = Date.now();

    return SPRITES[name];
}

/**
 * Load a sprite into the resources cache from a specific URL
 * 
 * @param name The name to give the sprite in the cache
 * @param url The path to the resource
 * @returns The newly created image/sprite
 */
export function loadImageFromUrl(name: string, url: string): GraphicsImage {
    const image = new GraphicsImage(name, new Image());
    SPRITES[name] = image;
    image.get().src = url;
    image.get().onload = () => { loadedCount--; };
    loadedCount++;
    LAST_SPRITES_UPDATE = Date.now();

    return SPRITES[name];
}

/**
 * Load a sound effect into the resources cache from a specific URL
 * 
 * @param name The name to give the sound effect in the cache
 * @param url The path to the resource
 */
export function loadSfxFromUrl(name: string, url: string): void {
    loadedCount++;

    var req = new XMLHttpRequest();
    req.open("GET", url, true);
    req.responseType = "arraybuffer";

    req.onload = (event) => {
        var arrayBuffer = req.response;
        if (arrayBuffer) {
            sfx[name] = arrayBuffer;
        }
        loadedCount--;
    };
    req.onerror = () => {
        alert("Error loading: " + name);
    }

    req.send();
}

/**
 * Load a sound effect into the resources cache
 * 
 * @param name The name to give the sound effect in the cache
 * @param resource The path to the resource
 */
function loadSfx(name: string, resource: string): void {
    loadedCount++;

    var req = new XMLHttpRequest();
    req.open("GET", RESOURCES[resource], true);
    req.responseType = "arraybuffer";

    req.onload = (event) => {
        var arrayBuffer = req.response;
        if (arrayBuffer) {
            sfx[name] = arrayBuffer;
        }
        loadedCount--;
    };
    req.onerror = () => {
        alert("Error loading: " + name);
    }

    req.send();
}

/**
 * Get a sprite from the cache with a specific name
 * 
 * @param name The name of the sprite to retrieve
 * @returns The sprite or undefined if the sprite couldn't be found
 */
export function getSprite(name: string): GraphicsImage {
    if (!SPRITES[name] && !reportedErrors[name]) {
        reportedErrors[name] = true;
        console.error("Couldn't locate sprite with name: " + name);
    }
    return SPRITES[name];
}

/**
 * Set whether audio should be muted
 * 
 * @param muted True if the sound should be muted
 */
export function setSoundMuted(muted: boolean): void {
    localStorage.setItem('muted', muted ? '1' : '0');
}
/**
 * Check if sound is muted
 * 
 * @return True if sound is muted
 */
export function isSoundMuted() {
    return localStorage.getItem("muted") === "1";
}

/**
 * Confirm the audio context - 
 */
export function confirmAudioContext(): void {
    if (!HEADLESS) {
        if (!audioContext) {
            audioContext = new AudioContext()
        }
        try {
            audioContext.resume().catch((e) => {
                console.log("Resume audio context failed");
                console.error(e);
            });
        } catch (e) {
            console.log("Resume audio context failed");
            console.error(e);
        }
    }
}

/**
 * Play a sound effect
 * 
 * @param name The name of the sound effect to play
 * @param variations The number of variations of the sound effect to choose from
 */
export function playSfx(name: string, volume: number, variations: number | null = null): void {
    if (HEADLESS) {
        return;
    }

    if (!audioContext || isSoundMuted()) {
        return;
    }

    confirmAudioContext();

    const variationName = variations ? `${name}_${(Math.floor(Math.random() * variations)).toString().padStart(3, '0')}` : name;
    const effect = sfx[variationName];

    if (effect) {
        const last = lastPlayed[variationName] ?? 0;
        if (Date.now() - last < 100) {
            return;
        }
        lastPlayed[variationName] = Date.now();

        if (!audioBuffers[variationName]) {
            const success = (buffer: AudioBuffer) => {
                audioBuffers[variationName] = buffer;
                playBuffer(buffer, volume);
            };
            const error = () => {
                console.warn("Unable to decode audio", name);
            };
            if (typeof Promise !== "undefined" && audioContext.decodeAudioData.length === 1) {
                audioContext.decodeAudioData(effect).then(success).catch(error);
            } else {
                audioContext.decodeAudioData(effect, success, error);
            }
        } else {
            playBuffer(audioBuffers[variationName], volume);
        }
    } else {
        if (!SPRITES[name] && !reportedErrors[variationName]) {
            reportedErrors[variationName] = true;
            console.log("Couldn't locate sfx with name: " + variationName);
        }
    }
}

function playBuffer(buffer: AudioBuffer, volume: number = 1): void {
    const source = audioContext.createBufferSource();
    const gainNode: GainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(volume, audioContext.currentTime);

    source.buffer = buffer;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);

    source.start(0);
}

let audioContext: AudioContext;

/**
 * Check if all the resources managed by this cache have been loaded
 * 
 * @returns True if all the resources have been loaded
 */
export function resourcesLoaded(): boolean {
    return loadedCount === 0;
}

/**
 * Load all the resources and associate them with keys
 */
export function loadAllResources(game: Game) {
    console.log("Loading Resources....");

    // load all the images and link them to a name based on directory structure
    for (const link of Object.keys(RESOURCES)) {
        if (link.startsWith("img")) {
            const key = link.substring("img/".length, link.length - 4);
            loadImage(key, link);
            if (!game.headless) {
                console.log(" ==> Loading Image: " + key);
            }
        }
        if (link.startsWith("sfx")) {
            const key = link.substring("sfx/".length, link.length - 4);
            loadSfx(key, link);
            if (!game.headless) {
                console.log(" ==> Loading SFX: " + key);
            }
        }
    }
}
