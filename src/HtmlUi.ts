import { Game } from "./Game";
import {GameMap, MAP_WIDTH, SKY_HEIGHT, TILE_SIZE} from "./Map";
import { Network } from "./Network";
import { confirmAudioContext, isSoundMuted, setSoundMuted } from "./engine/Resources";
import { ModRecord } from "./mods/ConfiguredMods";
import { getCodeEditorContent, hideCodeEditor, showCodeEditor } from "./mods/Editor";
import { ServerMod } from "./mods/ModApi";
import JSZip from "jszip";

/**
 * A controller for everything thats on the HTML layer rather than the canvas. The game
 * makes use of HTML components for the UI rather than drawing them manually on the canvas.
 */
export class HtmlUi {
    /** The input element used to accept user network chat */
    chatInput: HTMLInputElement;
    /** The input element used to set portal codes */
    portalInput: HTMLInputElement;
    /** The input element holding the players name */
    playernameInput: HTMLInputElement;
    /** The input element used to set the server ID to join */
    serverIdInput: HTMLInputElement;
    /** The button in the setting dialog for resetting the map */
    resetMapButton: HTMLDivElement;
    /** The button in the setting dialog for loading the map */
    loadMapButton: HTMLDivElement;
    /** The button in the setting dialog for saving the map */
    saveMapButton: HTMLDivElement;
    /** The file input element used to upload maps */
    fileInput: HTMLInputElement;
    /** The network in use */
    network: Network;
    /** The game map being maintained */
    gameMap: GameMap;
    /** The central game controller */
    game: Game;

    /** The visual list of mods */
    modsList: HTMLDivElement;
    /** The mod selected from the list */
    selectedMod?: ModRecord;
    /** The div of the mod selected */
    selectedModDiv?: HTMLDivElement;
    /** The file input element used to upload mods */
    modInput: HTMLInputElement;

    constructor(game: Game, network: Network, gameMap: GameMap) {
        this.game = game;
        this.network = network;
        this.gameMap = gameMap;

        this.modsList = document.getElementById("modsList") as HTMLDivElement;
        this.resetMapButton = document.getElementById("resetMapButton") as HTMLDivElement;
        this.loadMapButton = document.getElementById("loadMapButton") as HTMLDivElement;
        this.saveMapButton = document.getElementById("saveMapButton") as HTMLDivElement;
        this.fileInput = document.getElementById("fileInput") as HTMLInputElement;
        this.modInput = document.getElementById("modInput") as HTMLInputElement;
        this.chatInput = document.getElementById("chatinput") as HTMLInputElement;
        this.portalInput = document.getElementById("portalinput") as HTMLInputElement;
        this.playernameInput = document.getElementById("playerName") as HTMLInputElement;
        this.serverIdInput = document.getElementById("serverId") as HTMLInputElement;

        //
        // The file input is used to show the file selector in the browser. We programmatically
        // click it to show the choose. When the value is changed we load the data
        // selected and stick it in our map array
        //
        this.fileInput.addEventListener('change', () => {
            if (this.fileInput.files) {
                const reader = new FileReader();
                reader.onload = () => {
                    const rawData = new Uint8Array(reader.result as ArrayBuffer);
                    this.loadMapFromBuffer(rawData);

                    this.game.player.x = 200;
                    this.game.player.y = (SKY_HEIGHT - 6) * TILE_SIZE;
                    document.getElementById("settingsPanel")!.style.display = "none";
                    this.game.gameMap.save();
                    this.network.sendMapUpdate(undefined);
                }

                if (this.fileInput.files.length > 0) {
                    reader.readAsArrayBuffer(this.fileInput.files[0]);
                }
            }
        });

        this.modInput.addEventListener('change', () => {
            if (this.modInput.files) {
                const file = this.modInput.files[0];
                if (file.name.endsWith(".js")) {
                    // simple JS file
                    const reader = new FileReader();
                    reader.addEventListener("load", () => {
                        const content = reader.result as string;
                        const modData: any = {};
                        modData["mod.js"] = content;
                        this.game.serverSettings.addMod(modData, true);
                    });
                    reader.readAsText(file);
                } else {
                    // ZIP with resources
                    const reader = new FileReader();
                    new JSZip().loadAsync(file).then((zip: JSZip) => {
                        const modData: any = {};
                        let count = 0;
                        zip.forEach((path, file) => {
                            count++;
                            file.async(path.endsWith(".js") || path.endsWith(".json") ? "string" : "base64").then((value: string) => {
                                modData[path] = value;
                                count--;
                                if (count === 0) {
                                    this.game.serverSettings.addMod(modData, true);
                                }
                            });
                        });
                    });
                }
            }
        });

        // reset the map 
        this.resetMapButton.addEventListener("click", () => {
            if (confirm("Reset Map?") && this.game.isHostingTheServer) {
                this.gameMap.reset();
                this.network.sendMapUpdate(undefined);
                this.game.player.x = this.game.globalProperties.SPAWN_X as number * TILE_SIZE;
                this.game.player.y = this.game.globalProperties.SPAWN_Y as number * TILE_SIZE;
                document.getElementById("serverSettingsPanel")!.style.display = "none";
            }
        });
        //
        // saving the map - since this a browser based app we create a link with
        // an encoded URL of the map data and then click it as a download.
        //
        this.saveMapButton.addEventListener("click", () => {
            const data = this.gameMap.getMapData();
            const encoder = new TextEncoder();
            // copy the metadata
            const meta = JSON.parse(JSON.stringify(this.gameMap.metaData));
            meta.mapSize = data.f.length;
            meta.blockSize = 2;
            const metaAsBytes = Array.from(encoder.encode(JSON.stringify(meta)));
            const metaData = new Uint8Array([255, metaAsBytes.length >> 8, (metaAsBytes.length & 0xFF), ...metaAsBytes]);
            const wordData = new Uint16Array([...data.f, ...data.b]);
            const dataBlocks = new Uint8Array(3 + metaData.length + wordData.buffer.byteLength);
            dataBlocks.set(metaData, 0);
            dataBlocks.set(new Uint8Array(wordData.buffer), metaData.length);
            const blob = new Blob([dataBlocks], {
                type: "application/octet-stream"
            });
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const date = new Date().toLocaleString();
            link.download = "unearthed-level-" + date + ".bin";
            link.click();
        });
        // This is just to start the file chooser
        this.loadMapButton.addEventListener("click", () => {
            this.fileInput.click();
        });

        // start the game button - start the network on our server ID
        document.getElementById("startGame")!.addEventListener("click", () => {
            confirmAudioContext();

            this.startGame();
        });
        // join game button - just show the join game dialog
        document.getElementById("joinGame")!.addEventListener("click", () => {
            confirmAudioContext();

            document.getElementById("connect")!.style.display = "none";
            document.getElementById("githublink")!.style.display = "none";
            document.getElementById("join")!.style.display = "block";
        });
        // join game button - just show the setup dialog
        document.getElementById("setupButton")!.addEventListener("click", () => {
            confirmAudioContext();

            this.game.player.reset();
            document.getElementById("connect")!.style.display = "none";
            document.getElementById("setup")!.style.display = "block";
        });
        document.getElementById("serverSettingsButton")?.addEventListener("click", () => {
            document.getElementById("serverSettingsPanel")!.style.display = "block";
            document.getElementById("settingsPanel")!.style.display = "none";
        });
        document.getElementById("modsSettingsButton")?.addEventListener("click", () => {
            document.getElementById("modsPanel")!.style.display = "block";
            document.getElementById("settingsPanel")!.style.display = "none";
        });
        

        // done button from the settings panel. Apply the settings and go back to main menu
        document.getElementById("doneButton")!.addEventListener("click", () => {
            this.game.username = this.playernameInput.value;
            this.game.player.name = this.game.username;
            localStorage.setItem("username", this.game.username);
            document.getElementById("connect")!.style.display = "block";
            document.getElementById("setup")!.style.display = "none";

            this.network.updatePlayerList(this.game.mobs);
        });

        // settings button in the top right. When clicked display the
        // the setting menu.
        document.getElementById("settings")!.addEventListener("click", () => {
            const panel = document.getElementById("settingsPanel")!;
            if (panel.style.display === "block") {
                panel.style.display = "none";
            } else {
                panel.style.display = "block";

                if (this.game.isHostingTheServer) {
                    this.resetMapButton.style.display = "block";
                    this.loadMapButton.style.display = "block";
                    this.saveMapButton.style.display = "block";
                } else {
                    this.resetMapButton.style.display = "none";
                    this.loadMapButton.style.display = "none";
                    this.saveMapButton.style.display = "none";
                }
            }
        })
        // chat button in the top left. When clicked show the user
        // chat input
        document.getElementById("chat")!.addEventListener("click", () => {
            if (this.network.connected()) {
                if (this.chatInput.style.display === "block") {
                    this.hideChat();
                } else {
                    this.showChat();
                }
            }
        })
        // close button hide the settings panel
        document.getElementById("closeButton")!.addEventListener("click", () => {
            document.getElementById("settingsPanel")!.style.display = "none";
            if (!this.game.network.connected()) {
                document.getElementById("connect")!.style.display = "block";
            }
        })
        document.getElementById("closeModsButton")!.addEventListener("click", () => {
            document.getElementById("modsPanel")!.style.display = "none";
            document.getElementById("settingsPanel")!.style.display = "block";
        })
        document.getElementById("closeServerSettingsButton")!.addEventListener("click", () => {
            document.getElementById("serverSettingsPanel")!.style.display = "none";
            document.getElementById("settingsPanel")!.style.display = "block";
        })
        

        // sound on/off button
        document.getElementById("soundButton")!.addEventListener("click", () => {
            setSoundMuted(!isSoundMuted());

            this.renderSoundButton();
        })

        // sound on/off button
        document.getElementById("fullscreenButton")!.addEventListener("click", () => {
            this.setFullscreen(!this.isFullscreen());
        })

        document.getElementById("controllerButton")!.addEventListener("click", () => {
            this.game.startControllerSetup();
        })
        document.getElementById("keyboardSetupButton")!.addEventListener("click", () => {
            this.game.startKeyboardSetup();
        })



        // special cases for when chatting. Enter will send the message and escape
        // will hide the chat box.
        this.chatInput!.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.code === "Escape") {
                this.chatInput.value = "";
                document.getElementById("settingsPanel")!.style.display = "none";
                this.hideChat();
            }
            if (event.code === "Enter") {
                this.sendChat(this.chatInput.value);
                this.chatInput.value = "";
                this.hideChat();
            }
        });
        
        this.portalInput!.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.code === "Escape") {
                this.hidePortal();
            }
            if (event.code === "Enter") {
                const tileIndex = Math.floor(this.game.player.x / TILE_SIZE) + (Math.floor(this.game.player.y / TILE_SIZE) * MAP_WIDTH);
                const portal = this.gameMap.metaData.portals.find(portal => portal.tileIndex === tileIndex);
                if (portal) {
                    portal.code = this.portalInput.value;
                    if (this.game.isHostingTheServer) {
                        localStorage.setItem("portals", JSON.stringify(this.game.gameMap.metaData.portals));
                    }
                }
                this.hidePortal();
            }
        });
        
        // Joining the game is starting the game with a network that
        // acts as a client
        document.getElementById("joinButton")!.addEventListener("click", () => {
            this.joinAsClient();
        });

        // So we see variables in console. And change them without refreshing.
        if (window.location.href.includes('localhost')) {
            (window as any).game = game
        }

        this.renderSoundButton();

        const link = document.getElementById("serverLink") as HTMLDivElement;
        link.addEventListener("click", () => {
            navigator.clipboard.writeText(this.game.serverId);
            link.innerHTML = "COPIED!";
            setTimeout(() => {
                link.innerHTML = this.game.serverId;
            }, 2000)
        });
        
        document.getElementById("serverName")!.addEventListener('change', () => {
            this.game.serverSettings.setServerName((document.getElementById("serverName") as HTMLInputElement).value);
        });
        
        document.getElementById("accessPassword")!.addEventListener('change', () => {
            this.game.serverSettings.setAccessPassword((document.getElementById("accessPassword") as HTMLInputElement).value);
        });
        this.renderAccessAndName();

        document.getElementById("changeCreativeMode")!.addEventListener('click', () => {
            this.game.serverSettings.setCreativeMode(!this.game.serverSettings.isCreativeMode());
            this.renderChangeCreativeButton();
        });
        this.renderChangeCreativeButton();
        document.getElementById("changePublish")!.addEventListener('click', () => {
            this.game.serverSettings.setPublish(!this.game.serverSettings.isPublish());
            this.renderChangePublishButton();
        });
        this.renderChangePublishButton();
        document.getElementById("changeDefaultMods")!.addEventListener('click', () => {
            this.game.serverSettings.setUseDefaultMods(!this.game.serverSettings.useDefaultMods());
            this.renderDefaultModsButton();
        });
        this.renderDefaultModsButton();

        document.getElementById("changeWorldButton")!.addEventListener('click', () => {
            this.game.serverSettings.setEditable(!this.game.serverSettings.isEditable());
            this.renderChangeWorldButton();
        });
        this.renderChangeWorldButton();

        document.getElementById("addMod")!.addEventListener("click", () => {
            this.modInput.value = "";
            this.modInput.click();
        });

        document.getElementById("editMod")!.addEventListener("click", () => {
            if (this.selectedMod) {
                showCodeEditor(this.selectedMod.resources["mod.js"]);
            }
        });

        document.getElementById("codeSaveButton")!.addEventListener("click", () => {
            this.saveCodeEditor();
        });
        document.getElementById("codeDownloadButton")!.addEventListener("click", () => {
            if (this.selectedMod) {
                const url = window.URL.createObjectURL(new Blob(
                    [ getCodeEditorContent() ],
                    {
                        type : "text/plain;charset=utf-8"
                    }
                ));
                const link = document.createElement('a');
                link.href = url;
                const date = new Date().toLocaleString();
                link.download = "mod.js";
                link.click();
            }
        });

        document.getElementById("codeCancelButton")!.addEventListener("click", () => {
            hideCodeEditor();
        });

        document.getElementById("removeMod")!.addEventListener("click", () => {
            if (this.selectedMod) {
                this.game.serverSettings.removeMod(this.selectedMod);
                this.selectedModDiv?.parentNode?.removeChild(this.selectedModDiv);
                this.selectedMod = undefined;
                this.selectedModDiv = undefined;
            }
        });
    }

    renderAccessAndName(): void {
        (document.getElementById("serverName") as HTMLInputElement).value = this.game.serverSettings.getServerName();
        (document.getElementById("accessPassword")as HTMLInputElement).value = this.game.serverSettings.getAccessPassword();
    }
    
    loadMapFromBuffer(rawData: Uint8Array) {
        if (rawData[0] === 255) {
            // new file format with room for meta
            const lengthOfMeta = ((rawData[1] << 8) & 0xFF00) + rawData[2];
            const decoder = new TextDecoder();
            const metaAsText = decoder.decode(rawData.slice(3, 3+lengthOfMeta));
            const meta = JSON.parse(metaAsText);

            const len: number = meta.mapSize;
            let blockData: Uint8Array | Uint16Array = rawData.slice(3+lengthOfMeta);
            // 2 bytes per block mode
            if (meta.blockSize === 2) {
                blockData = new Uint16Array(rawData.buffer, 3+lengthOfMeta, len * 2);
            }
            const fullArray: number[] = Array.from(blockData);
            this.gameMap.setMapData({
                f: fullArray.slice(0, len),
                b: fullArray.slice(len)
            });
            Object.assign(this.gameMap.metaData, meta);
        } else {
            const fullArray: number[] = Array.from(rawData);
            const len: number = fullArray.length / 2;
            this.gameMap.setMapData({
                f: fullArray.slice(0, len),
                b: fullArray.slice(len)
            });
        }
    }

    startGame() {
        this.game.isHostingTheServer = true;
        document.getElementById("connect")!.style.display = "none";
        document.getElementById("githublink")!.style.display = "none";
        
        this.network.startNetwork(this.game.isHostingTheServer);
        this.game.connecting = true;
        this.game.waitingForHost = true;
        this.game.player.reset();
        document.getElementById("serverLink")!.innerHTML = this.game.serverId;
    }

    codeEditorShowing() {
        return document.getElementById("codePanel")?.style.display === "block";
    }

    renderChangeWorldButton() {
        document.getElementById("changeWorldButton")!.innerHTML = this.game.serverSettings.isEditable() ? "Yes" : "No";
    }

    renderChangePublishButton() {
        document.getElementById("changePublish")!.innerHTML = this.game.serverSettings.isPublish() ? "Yes" : "No";
    }

    renderChangeCreativeButton() {
        document.getElementById("changeCreativeMode")!.innerHTML = this.game.serverSettings.isCreativeMode() ? "Yes" : "No";
    }

    renderDefaultModsButton() {
        document.getElementById("changeDefaultMods")!.innerHTML = this.game.serverSettings.useDefaultMods() ? "Yes" : "No";
    }

    joinAsClient() {
        this.game.isHostingTheServer = false;
        this.game.serverId = this.serverIdInput.value;
        this.game.username = this.playernameInput.value;
        this.game.player.name = this.game.username;
        this.network.updatePlayerList(this.game.mobs);

        document.getElementById("join")!.style.display = "none";
        this.network.startNetwork(this.game.isHostingTheServer);
        this.game.connecting = true;
        this.game.waitingForHost = true;
    }

    setFullscreen(fs: boolean) {
        if (fs) {
            const doc: any = document.body;
            if (doc.requestFullscreen) {
                doc.requestFullscreen().then(() => {
                    setTimeout(() => { this.renderFullscreenButton(); }, 1000);
                });
            } else if (doc.mozRequestFullscreen) {
                doc.mozRequestFullscreen().then(() => {
                    setTimeout(() => { this.renderFullscreenButton(); }, 1000);
                });

            } else if (doc.webkitRequestFullscreen) {
                doc.webkitRequestFullscreen().then(() => {
                    setTimeout(() => { this.renderFullscreenButton(); }, 1000);
                });

            }
        } else {
            const doc: any = document;
            if (doc.exitFullscreen) {
                doc.exitFullscreen().then(() => {
                    setTimeout(() => { this.renderFullscreenButton(); }, 1000);
                });
            } else if (doc.mozExitFullscreen) {
                doc.mozExitFullscreen().then(() => {
                    setTimeout(() => { this.renderFullscreenButton(); }, 1000);
                });
            } else if (doc.webkitExitFullscreen) {
                doc.webkitExitFullscreen().then(() => {
                    setTimeout(() => { this.renderFullscreenButton(); }, 1000);
                });
            }
        }
    }

    isFullscreen(): boolean {
        return (document.fullscreenElement !== null)
    }
    /**
     * Show the chat input
     */
    showChat() {
        if (this.network.connected()) {
            this.chatInput!.style.display = "block";
            this.chatInput.focus();
        }
    }

    /**
     * Save the contents of the code editor
     */
    saveCodeEditor() {
        if (this.selectedMod) {
            if (this.game.serverSettings.updateMod(this.selectedMod, getCodeEditorContent())) {

                if (this.selectedModDiv) {
                    this.selectedModDiv.innerHTML = this.selectedMod.mod.name + " ("+this.selectedMod.mod.version+")";
                }
                hideCodeEditor();
            }
        }
    }

    /**
     * Send a chat message
     * 
     * @param message The message to send
     */
    sendChat(message: string) {
        if (this.network.connected()) {
            this.network.sendChatMessage(this.game.player.name, message);
        }
    }

    /**
     * Hide the chat input
     */
    hideChat() {
        this.chatInput!.style.display = "none";
    }

    /**
     * Show the portal input
     */
    showPortal() {
        this.portalInput!.style.display = "block";
        this.portalInput!.focus();
    }
    
    hidePortal() {
        this.portalInput.value = "";
        document.getElementById("portalinput")!.style.display = "none";
    }
	
    /**
     * Show which sound icon based on current user preference.
     */
    renderSoundButton() {
        let button = document.getElementById("soundButton");
        if (button) {
            if (localStorage.getItem('muted') === '1') {
                button.classList.add('isoff');
            } else {
                button.classList.remove('isoff');
            }
        }
    }

    /**
     * Show which if we're in fullscreen or not
     */
    renderFullscreenButton() {
        let button = document.getElementById("fullscreenButton");
        console.log(button,this.isFullscreen());
        if (button) {
            if (this.isFullscreen()) {
                button.classList.add('isFullscreen');
            } else {
                button.classList.remove('isFullscreen');
            }
        }
    }

    addMod(mod: ModRecord) {
        const modDiv = document.createElement("div");
        modDiv.classList.add("mod");
        modDiv.id = "mod" + Date.now();
        modDiv.innerHTML = mod.mod.name + " ("+mod.mod.version+")";
        modDiv.addEventListener("click", () => {
            this.selectMod(mod, modDiv);
        })
        this.modsList.appendChild(modDiv);
    }

    selectMod(mod: ModRecord, div: HTMLDivElement) {
        const list = document.getElementsByClassName("modSelected");
        for (let i=0;i<list.length;i++) {
            list.item(i)?.classList.remove("modSelected");
        }

        div.classList.add("modSelected");
        this.selectedMod = mod;
        this.selectedModDiv = div;
    }
}