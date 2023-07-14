import { DataPacket_Kind, RemoteParticipant, Room, RoomEvent } from 'livekit-client';
import { Mob } from './Mob';
import { GameMap, GameMapMetaData, TILE_SIZE } from './Map';
import { Game } from './Game';
import { ServerConfig } from './ServerSettings';
import { Particle, addParticle } from './engine/Particles';
import { getSprite } from './engine/Resources';
import { v4 as uuidv4 } from 'uuid';
import { Layer } from './mods/ModApi';

//
// Network is handled by using WebRTC through https://livekit.io/ 
//
// They're really designed for video/audio rooms but since they support data channel
// its particularly easy to set up P2P network through them. They have a fault tolerant local access
// point based network through their service and give a generous 50GB of transfer a month free
// 
// In short they're awesome, go use it
//

/** Interval between updates sent from server and client - 1/10th of a second */
const UPDATE_INTERVAL_MS: number = 100;
/** Interval between asking for the map if we haven't had it yet - once a second */
const MAP_REQUEST_INTERVAL: number = 5000;
/** How often we ping the room server to let it know the server is alive */
const ROOM_SERVICE_PING_INTERVAL: number = 60 * 1000;

/** 
 * The network password using to access cokeandcode's service - 
 * this is set from your local.properties.json - if you don't have one a blank value means no network 
 */
const NETWORK_PASSWORD: string = "_ROOMPASSWORD_";
/** True if networking is enabled */
const NETWORKING_ENABLED: boolean = NETWORK_PASSWORD !== "";

interface MessagePart {
    index: number;
    content: string;
}

interface MultipartMessage {
    parts: MessagePart[];
    id: string;
    count: number;
}

interface NetworkItem {
    x: number;
    y: number;
    count: number;
    itemType: string;
    itemId: string;
}

/**
 * A webrtc based peer to peer network that allocates one player as server and then forwards
 * state updates between players. 
 */
export class Network {
    /** used to encode blobs across the network */
    encoder = new TextEncoder();
    /** used to decode blobs across the network */
    decoder = new TextDecoder();
    /** The livekit.io Room we're using */
    room = new Room();
    /** The last time there was an update sent */
    lastUpdate = Date.now();
    /** The last time the map was requested */
    lastMapRequest = Date.now();
    /** The last time a host update was received */
    lastHostUpdate = Date.now();
    /** True if we're connected to the network */
    isConnected = false;
    /** True if this client is hosting the server */
    thisIsTheHostServer = false;
    /** The list of mobs that we're syncing across the network */
    localMobs: Mob[] = [];
    /** The player thats considered local and shouldn't be updated from the network */
    localPlayer?: Mob;
    /** True if we've received the game map */
    hadMap: boolean = false;
    /** The participant that represents the remote hosting server (if we're not the host) */
    hostParticipantId: RemoteParticipant | undefined;
    /** The list of mobs names that have been removed */
    removed: string[] = [];
    /** True if the networking has been started */
    started: boolean = false;
    /** The game map this network is running against */
    gameMap: GameMap;
    /** The central game controller */
    game: Game;
    /** The hosting servers config */
    serverConfig?: ServerConfig;
    /** The list of pending multipart messages */
    pendingMultipart: MultipartMessage[] = [];
    /** True if the connection failed for some reason */
    connectionFailed: boolean = false;
    /** Reason for the connection failure */
    connectionFailedReason: string = "";
    /** True if we're received the server settings and loaded the mods */
    hasServerSettings: boolean = false;
    /** The items to add once we've loaded mods */
    itemsToAdd: NetworkItem[] = [];
    /** True if we have enough information to render */
    readyToRender: boolean = false;
    /** Last ping of room server */
    lastPingToRoomService: number = 0;

    /**
     * Create a new network session
     * 
     * @param game The central game controller
     * @param map The map to maintain
     */
    constructor(game: Game, map: GameMap) {
        this.game = game;
        this.gameMap = map;
    }

    /**
     * Update the visual list of players connected 
     * 
     * @param mobs The list of mobs that are the players
     */
    updatePlayerList(mobs: Mob[]): void {
        const listDiv = document.getElementById("playerList")!;
        listDiv.innerHTML = "";

        for (const mob of mobs) {
            if (mob.isPlayerControlled()) {
                const div = document.createElement("div");
                div.innerHTML = mob.name.substring(0, 12);
                div.classList.add("nametag");
                listDiv.appendChild(div);
            }
        }
    }

    /**
     * Check if we're connected to the networking service.
     * 
     * @returns True if we're connected to the network
     */
    connected(): boolean {
        if (!NETWORKING_ENABLED) {
            return this.started;
        }

        return (this.hostParticipantId !== undefined) || this.thisIsTheHostServer;
    }

    accessRoomService(accessPassword: string): { host: boolean, token: string } | null {
        this.lastPingToRoomService = Date.now();

        // request a token for accessing a LiveKit.io room. This is currently hard wired to the cokeandcode 
        // provider that uses kev's hidden livekit key. 
        const request = new XMLHttpRequest();
        request.open("GET", "https://unearthedgame.net/room3.php?username=" + encodeURIComponent(this.game.username!) +
            "&room=" + encodeURIComponent(this.game.serverId) + 
            "&serverPassword=" + encodeURIComponent(this.game.serverPassword) + 
            "&password=" + encodeURIComponent(NETWORK_PASSWORD)+
            "&serverName=" + encodeURIComponent(this.game.serverSettings.getServerName())+
            "&accessPassword=" + encodeURIComponent(accessPassword), false);
        request.send();

        if (request.responseText === "Access Denied") {
            const password = prompt("This server requires a password:");
            if (!password) {
                return null;
            }

            return this.accessRoomService(password);
        }

        if (request.responseText === "Invalid Password") {
            console.log("Invalid password was specified to access the room directory. Check local.properties");
            this.started = false;
            this.connectionFailed = true;
            this.connectionFailedReason = "Invalid Room Directory Password";
            return null;
        }

        const token = request.responseText.split("&")[0];
        const host = request.responseText.split("&")[1] === "true";
        console.log("Central Server confirms this is host: " + host);

        return { token, host }
    }

    /**
     * Start the networking service 
     * 
     * @param hosting True if we want to host the game
     */
    async startNetwork(hosting: boolean): Promise<void> {
        this.started = true;
        this.connectionFailed = false;

        // if we're the server, we initialise mods there
        if (hosting || !NETWORKING_ENABLED) {
            this.game.mods.init();
            this.hadMap = true;
        }

        if (hosting) {
            this.serverConfig = this.game.serverSettings.getConfig();
        }

        if (!NETWORKING_ENABLED) {
            this.thisIsTheHostServer = true;
            this.postNetworkSetup();
            return;
        }

        console.log("Connecting to room server");

        try {
            const roomAccessDetails = this.accessRoomService(this.game.serverSettings.getAccessPassword());
            if (roomAccessDetails === null) {
                // an error occurred and we didn't get room access details, give up
                return;
            }

            this.thisIsTheHostServer = hosting;
            const wsURL = "wss://talesofyore.livekit.cloud"

            // connect to the live kit room
            await this.room.connect(wsURL, roomAccessDetails.token);
        } catch (e) {
            console.log("Connecting failed");
            console.error(e);
            this.started = false;
            this.connectionFailed = true;
            this.connectionFailedReason = "Network Error";
            return;
        }

        this.room.on(RoomEvent.ParticipantConnected, (participant) => {
            console.log("Participant connected: " + participant.name);
        });

        this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
            // if the hosting participant disconnects then go into frozen mode
            // until we get one back
            if (participant === this.hostParticipantId) {
                this.hostParticipantId = undefined;
                this.localMobs.splice(0, this.localMobs.length);
                this.localMobs.push(this.localPlayer!);
            } else {
                // otherwise if a participant disconnects remove their 
                // mob from the game
                const mob = this.localMobs.find(m => m.participantId === participant.sid);
                if (mob) {
                    this.localMobs.splice(this.localMobs.indexOf(mob), 1);
                    this.removed.push(mob.id);
                    const data = JSON.stringify({ type: "remove", mobId: mob.id });
                    this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE);
                    this.updatePlayerList(this.localMobs);
                } else {
                    console.log("No Mob found for participant");
                }
            }
        });

        // process messages received 
        this.room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
            const messageIsFromHost = participant?.metadata === "true";
            if (messageIsFromHost) {
                this.hostParticipantId = participant!;
            }

            // if the topic is "map" then we've got a big
            // binary blob coming that is the tile mapS
            if (topic === "fgmap") {
                // only accept map updates from authenticated hosts
                if (messageIsFromHost) {
                    if (!this.thisIsTheHostServer) {
                        const buffer = new Uint8Array(payload.length);
                        buffer.set(Array.from(payload), 0);
                        const array = new Uint16Array(buffer.buffer, 0, buffer.length / 2);

                        // parse the blob and update the game map
                        const fullArray: number[] = Array.from(array);
                        this.gameMap.setForegroundMapData(fullArray);
                        this.hadMap = true;

                        this.localPlayer?.reset();
                    }
                }
            } else if (topic === "bgmap") {
                // only accept map updates from authenticated hosts
                if (messageIsFromHost) {
                    if (!this.thisIsTheHostServer) {
                        // parse the blob and update the game map
                        const buffer = new Uint8Array(payload.length);
                        buffer.set(Array.from(payload), 0);
                        const array = new Uint16Array(buffer.buffer, 0, buffer.length / 2);

                        // parse the blob and update the game map
                        const fullArray: number[] = Array.from(array);
                        this.gameMap.setBackgroundMapData(fullArray);
                        this.hadMap = true;

                        this.localPlayer?.reset();
                    }
                }
            } else {
                const strData = this.decoder.decode(payload);
                const message = JSON.parse(strData);

                this.processMessage(message, participant, hosting, messageIsFromHost);
            }
        });

        console.log("Network started");
        this.isConnected = true;

        this.postNetworkSetup();

    }

    private postNetworkSetup(): void {
        if (this.thisIsTheHostServer) {
            this.game.mods.worldStarted();
            // TODO - think about combining the 3 versions of this and persisting
            // a players position when they were in this world last against their unique player ID
            this.game.player.x = (this.game.globalProperties.SPAWN_X as number) * TILE_SIZE;
            this.game.player.y = (this.game.globalProperties.SPAWN_Y as number) * TILE_SIZE;
            this.game.mods.mobAdded(this.game.player);

            this.readyToRender = true;
        }
    }

    private processMessage(message: any, participant: RemoteParticipant | undefined, hosting: boolean, messageIsFromHost: boolean): void {
        switch (message.type) {
            case "part": {

                let existing = this.pendingMultipart[message.id];
                if (!existing) {
                    existing = this.pendingMultipart[message.id] = {
                        parts: [],
                        id: message.id,
                        count: message.count
                    };
                }
                existing.parts.push({
                    content: message.content,
                    index: message.index
                });

                if (existing.count === existing.parts.length) {
                    existing.parts.sort((a, b) => {
                        return a.index - b.index;
                    });

                    let result = "";
                    for (const part of existing.parts) {
                        result += part.content;
                    }

                    this.processMessage(JSON.parse(result), participant, hosting, messageIsFromHost);
                }
                break;
            }
            case "requestMap": {
                console.log("Got request for map");
                if (hosting) {
                    if (participant) {
                        this.sendMapUpdate(participant.sid);
                    }
                }
                break;
            }
            case "item": {
                if (!hosting) {
                    if (!this.hasServerSettings) {
                        this.itemsToAdd.push(message);
                    } else {
                        this.gameMap.addItem(message.x, message.y, message.count, message.itemType, message.itemId);
                    }
                }
                break;
            }
            case "items": {
                if (!hosting) {
                    // record the list of items, we'll have to wait for any mods to be
                    // loaded before apply them
                    if (!this.hasServerSettings) {
                        this.itemsToAdd.push(...message.items);
                    } else {
                        for (const item of message.items) {
                            this.gameMap.addItem(item.x, item.y, item.count, item.itemType, item.itemId);
                        }
                    }
                }
                break;
            }
            case "collect": {
                if (!hosting) {
                    let targetMob = this.localMobs.find(mob => mob.id === message.mobId);
                    this.gameMap.removeItem(message.itemId, targetMob)
                }
                break;
            }
            case "particles": {
                if (!hosting) {
                    this.applyParticles(message.image, message.x, message.y, message.count);
                }
                break;
            }
            case "mapMeta": {
                if (!hosting) {
                    Object.assign(this.gameMap.metaData, message.data);
                }
                break;
            }
            case "serverConfig": {
                if (!hosting) {
                    if (message.data.editable && !this.serverConfig?.editable) {
                        this.addChat("", "Editing Enabled");

                    }

                    this.game.serverSettings.fromNetwork = true;
                    this.serverConfig = message.data;

                    if (this.serverConfig) {
                        // remote configuration and mods applied to the client side
                        this.game.serverSettings.setEditable(this.serverConfig.editable);
                        this.game.serverSettings.setCreativeMode(this.serverConfig.creativeMode);
                        this.game.serverSettings.setUseDefaultMods(this.serverConfig.useDefaultMods);

                        this.game.serverSettings.loadModsFrom(this.serverConfig);

                        this.game.mods.init();
                        this.game.mods.worldStarted();

                        // TODO - think about combining the 3 versions of this and persisting
                        // a players position when they were in this world last against their unique player ID
                        this.game.player.x = (this.game.globalProperties.SPAWN_X as number) * TILE_SIZE;
                        this.game.player.y = (this.game.globalProperties.SPAWN_Y as number) * TILE_SIZE;
                        this.game.mods.mobAdded(this.game.player);
                    }

                    this.hasServerSettings = true;

                    if (!this.serverConfig?.editable) {
                        this.addChat("", "Editing Disabled");
                    }

                    for (const item of this.itemsToAdd) {
                        this.gameMap.addItem(item.x, item.y, item.count, item.itemType, item.itemId);
                    }
                    this.itemsToAdd = [];

                    this.readyToRender = true;
                }
                break;
            }
            case "chatMessage": {
                this.addChat(message.who, message.message);
                break;
            }
            case "trigger": {
                if (this.thisIsTheHostServer && participant) {
                    const sourceMob = this.localMobs.find(m => m.id === message.source);
                    if (sourceMob) {
                        this.game.playerTriggeredLocation(sourceMob, message.x, message.y, false);
                    }
                }
                break;
            }
            case "iAmHost": {
                if (!hosting) {
                    if (messageIsFromHost) {
                        this.hostParticipantId = participant!;
                        if (message.version !== "_VERSION_") {
                            alert("Game Version Mismatch");
                            location.reload();
                        }
                    }
                }
                break;
            }
            case "tileChange": {
                // only accept host messages from authenticated hosts or if we're the server
                if (messageIsFromHost || this.thisIsTheHostServer) {
                    if (this.serverConfig?.editable) {
                        if (participant) {
                            const sourceMob = this.localMobs.find(m => m.id === message.source);
                            if (this.thisIsTheHostServer) {
                                this.sendNetworkTile(sourceMob, message.x, message.y, message.tile, message.layer, message.toolId);
                            } else {
                                this.gameMap.setTile(message.x, message.y, message.tile, message.layer);
                            }
                        }
                    }
                }
                break;
            }
            case "remove": {
                const mob = this.localMobs.find(mob => mob.id === message.mobId);
                if (mob) {
                    this.removed.push(mob.id);
                    this.localMobs.splice(this.localMobs.indexOf(mob), 1);
                    this.updatePlayerList(this.localMobs);
                }
                break;
            }
            case "mobs": {
                // the mains state update - all the mobs encoded with their network
                // state. If any mob didn't get an update for a while then 
                // remove it as a timeout. If we don't have a mob for a state update
                // then create it as a new player.
                if (this.localMobs && this.localPlayer) {
                    // clients should only be sending 1 mob update - 
                    if (message.data.length === 1 || messageIsFromHost) {
                        for (const mobData of message.data) {
                            if (mobData.id !== this.localPlayer.id) {
                                if (this.removed.includes(mobData.id)) {
                                    continue;
                                }

                                let targetMob = this.localMobs.find(mob => mob.id === mobData.id);
                                if (!targetMob) {
                                    targetMob = new Mob(this, this.gameMap, mobData.id, mobData.name, mobData.isPlayer, mobData.type, mobData.x, mobData.y);
                                    this.localMobs.push(targetMob);
                                    this.updatePlayerList(this.localMobs);

                                    if (targetMob.isPlayer()) {
                                        // TODO - think about combining the 3 versions of this and persisting
                                        // a players position when they were in this world last against their unique player ID
                                        targetMob.x = (this.game.globalProperties.SPAWN_X as number) * TILE_SIZE;
                                        targetMob.y = (this.game.globalProperties.SPAWN_Y as number) * TILE_SIZE;
                                    }

                                    this.game.mods.mobAdded(this.game.player);
                                }

                                if (participant) {
                                    targetMob.participantId = participant.sid;
                                }
                                targetMob.updateFromNetworkState(mobData);
                            }
                        }
                    }
                }
                break;
            }
            default: {
                console.log("Unknown message type: " + message.type);
            }
        }
    }

    /**
     * Add a chat to the session
     * 
     * @param who The name of the player that sent the chat
     * @param message The message they sent
     */
    addChat(who: string, message: string): void {
        if (!NETWORKING_ENABLED) {
            return;
        }

        // add the chat into the HTML
        const list = document.getElementById("chatList") as HTMLDivElement;

        while (list.childElementCount > 4) {
            if (list.firstChild) {
                list.firstChild.parentNode?.removeChild(list.firstChild);
            }
        }

        const line = document.createElement("div");
        line.classList.add("chatline");
        const name = document.createElement("div");
        name.classList.add("chatname");
        name.innerHTML = who.substring(0, 12);
        const msg = document.createElement("div");
        msg.classList.add("chattext");
        msg.innerHTML = message.substring(0, 100);
        line.appendChild(name);
        line.appendChild(msg);

        list.appendChild(line);
    }

    /**
     * Send notification that a non-server player pushed a trigger. This lets the 
     * server know so it can inform any mods.
     * 
     * @param x The x coordinate of the location of the trigger (in tiles) 
     * @param y The y coordinate of the location of the trigger (in tiles) 
     */
    sendTrigger(x: number, y: number): void {
        if (this.isConnected && !this.thisIsTheHostServer && this.hostParticipantId) {
            const message = { type: "trigger", x, y, source: this.game.player.id };
            this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE, [this.hostParticipantId]);
        }
    }

    /**
     * Break up a potentially large message into chunks to not break UDP packet sizes
     * 
     * @param content The content to break up
     * @param target The target to send the message to
     */
    private sendMultipartMessage(content: string, target?: string): void {
        const blockSize = 60000;
        const total = Math.ceil(content.length / blockSize);
        const id = uuidv4();
        for (let i = 0; i < total; i++) {
            const message = { id: id, type: "part", index: i, count: total, content: content.substring(i * blockSize, (i + 1) * blockSize) };
            if (target) {
                this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE, [target]);
            } else {
                this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE);
            }
        }
    }

    /**
     * Send the server configuration (which includes mods) to the clients. This lets them
     * have a chance in the future of having parts of the mods that run for them too. This is
     * also here to support client side understanding of no-edit servers.
     * 
     * @param serverSettings The server settings that should be sent over.
     */
    sendServerSettings(serverSettings: ServerConfig, target?: string): void {
        if (this.isConnected) {
            const toSend = JSON.parse(JSON.stringify(serverSettings));
            // don't send binary lumps across, we'll blow the message stack
            for (const script of toSend.modScripts) {
                for (const key of Object.keys(script)) {
                    if (key.endsWith(".bin")) {
                        delete script[key];
                    }
                }
            }
            const message = { type: "serverConfig", data: toSend };
            this.sendMultipartMessage(JSON.stringify(message), target);
        }
    }

    /**
     * Send the meta data associated with the game world. This is an amorphous blob of 
     * JSON that can contain anything.
     * 
     * @param metaData The metadata to be sent
     */
    sendMetaData(metaData: GameMapMetaData, target?: string): void {
        if (this.isConnected) {
            const message = { type: "mapMeta", data: metaData };
            if (target) {
                this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE, [target]);
            } else {
                this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(message)), DataPacket_Kind.RELIABLE);
            }
        }
    }

    /**
     * Send the state of block/tile map out across the network. This can either be
     * because a client requested it (then the target will be set) or at the start 
     * when the host joins and all players need it
     * 
     * @param target The participant ID of the player to send the map to or undefined to broadcast to all
     */
    sendMapUpdate(target: string | undefined) {
        if (!NETWORKING_ENABLED) {
            return;
        }
        if (!this.isConnected) {
            return;
        }

        const data = this.gameMap.getMapData();

        // make it even with the header that livekit adds
        const fgDataBlocks = new Uint16Array([...data.f]);
        const bgDataBlocks = new Uint16Array([...data.b]);
        const foreground = new Uint8Array(fgDataBlocks.buffer, 0, fgDataBlocks.byteLength);
        const background = new Uint8Array(bgDataBlocks.buffer, 0, fgDataBlocks.byteLength);

        const existingItems = this.gameMap.allItems().map(i => {
            return {
                x: i.x,
                y: i.y,
                count: i.count,
                itemType: i.def.type,
                itemId: i.id
            }
        });

        const itemsMessage = { type: "items", items: existingItems };

        if (target) {
            this.room.localParticipant.publishData(foreground, DataPacket_Kind.RELIABLE, { topic: "fgmap", destination: [target] });
            this.room.localParticipant.publishData(background, DataPacket_Kind.RELIABLE, { topic: "bgmap", destination: [target] });

            this.sendMetaData(this.gameMap.metaData, target);
            if (this.serverConfig) {
                this.sendServerSettings(this.serverConfig, target);
            }
            this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(itemsMessage)), DataPacket_Kind.RELIABLE, [target]);
        } else {
            this.room.localParticipant.publishData(foreground, DataPacket_Kind.RELIABLE, { topic: "fgmap" });
            this.room.localParticipant.publishData(background, DataPacket_Kind.RELIABLE, { topic: "bgmap" });

            this.sendMetaData(this.gameMap.metaData);
            if (this.serverConfig) {
                this.sendServerSettings(this.serverConfig);
            }
            this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(itemsMessage)), DataPacket_Kind.RELIABLE);
        }
    }

    sendItemCreate(x: number, y: number, count: number, itemType: string): string | undefined {
        if (this.thisIsTheHostServer) {
            const itemId = this.gameMap.addItem(x, y, count, itemType);
            const data = {
                type: "item",
                x,
                y,
                count,
                itemType,
                itemId
            }
            this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(data)), DataPacket_Kind.RELIABLE);

            return itemId;
        }

        return undefined;
    }

    sendItemCollection(itemId: string, mobId: string): void {
        if (this.thisIsTheHostServer) {
            this.gameMap.removeItem(itemId, this.localMobs.find(m => m.id === mobId));
            const data = {
                type: "collect",
                mobId,
                itemId
            }
            this.room.localParticipant.publishData(this.encoder.encode(JSON.stringify(data)), DataPacket_Kind.RELIABLE);
        }
    }

    /**
     * Send a tile update across the network. This will be forwards to other via the server.
     * 
     * @param player The player setting the network tile 
     * @param x The x coordinate of the tile being update
     * @param y The y coordinate of the tile being update
     * @param tile The tile to place on the map (or 0 to remove)
     * @param layer The layer to place the tile on
     * @param toolId The ID of the tool being used if any
     */
    sendNetworkTile(player: Mob | undefined, x: number, y: number, tile: number, layer: number, toolId: string = "") {
        const oldBlock = this.gameMap.getTile(x, y, layer);
        if (oldBlock === tile && !toolId) {
            return;
        }
        const oldBackground = this.gameMap.getTile(x, y, Layer.BACKGROUND);

        if (this.thisIsTheHostServer) {
            // if we're the server we're authoritative so the mods can run based on the change
            if (toolId.length > 0 && !this.game.mods.inModContext()) {
                // using a tool
                this.game.mods.tool(player, x, y, layer, toolId);

                return;
            }
        }
        // if we're the host then forward the update to all players
        // only set zero if we're using the default pick
        if (tile !== 0 || this.game.mods.inModContext()) {
            // note if the mod changed the background tile then we don't want to apply the default leaveBackground
            // flag

            // NOTE: If the tile is a remote client it'll set but then be undone by the server 
            // if incorrectly placed etc
            this.gameMap.setTile(x, y, tile, layer, oldBackground === this.gameMap.getTile(x, y, Layer.BACKGROUND));
        }

        if (this.thisIsTheHostServer) {
            // if we're the server we're authoritative so the mods can run based on the change
            this.game.mods.tile(player, x, y, layer, tile, oldBlock);
        }

        if (!NETWORKING_ENABLED) {
            return;
        }

        if (this.thisIsTheHostServer) {
            if (!this.isConnected) {
                return;
            }

            const data = JSON.stringify({ type: "tileChange", x, y, tile, layer, toolId, source: player?.id });
            this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE);
        } else if (this.hostParticipantId) {
            if (this.serverConfig?.editable) {
                // if we have a host then send it to just that host
                const data = JSON.stringify({ type: "tileChange", x, y, tile, layer, toolId, source: player?.id });
                this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE, [this.hostParticipantId.sid]);
            }
        }
    }

    /**
     * Apply a particle effect either locally or received from the server
     * 
     * @param image The image to be used for the particle
     * @param x The x coordinate of the location where the particles should be spawned in world coordinate
     * @param y The y coordinate of the location where the particles should be spawned in world coordinate
     * @param count The number of particles to be spawned
     */
    private applyParticles(image: string, x: number, y: number, count: number) {
        for (let i = 0; i < count; i++) {
            const ox = (Math.random() - 0.5) * TILE_SIZE;
            const oy = (Math.random() - 0.5) * TILE_SIZE;
            const vx = (Math.random() - 0.5) * 10;
            const vy = (-Math.random()) * 10;
            const life = 0.5 + (Math.random() * 0.5);

            addParticle(new Particle(getSprite(image), life, x + ox, y + oy, vx, vy));
        }
    }

    /**
     * Send clients notification that particles need to be spawned
     * 
     * @param image The image to be used for the particle
     * @param x The x coordinate of the location where the particles should be spawned in world coordinate
     * @param y The y coordinate of the location where the particles should be spawned in world coordinate
     * @param count The number of particles to be spawned
     */
    sendParticles(image: string, x: number, y: number, count: number) {
        if (this.thisIsTheHostServer) {
            this.applyParticles(image, x, y, count);
        }

        if (!NETWORKING_ENABLED) {
            return;
        }

        if (!this.isConnected) {
            return;
        }

        const data = JSON.stringify({ type: "particles", x, y, image, count });
        this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE);
    }

    /**
     * Send a chat messages across the network
     * 
     * @param who The name of the player sending the chat
     * @param message The message to send
     */
    sendChatMessage(who: string, message: string) {
        if (!NETWORKING_ENABLED) {
            return;
        }

        if (!this.isConnected) {
            return;
        }

        message = message.trim();
        if (message.length === 0) {
            return;
        }

        // broadcast the chat to everyone
        const data = JSON.stringify({ type: "chatMessage", who, message });
        this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE);

        this.addChat(who, message);
    }

    /**
     * Update the network by sending any regular messages
     * 
     * @param player The local player Mob
     * @param players The list of mob to sync
     */
    update(player: Mob, players: Mob[]) {
        this.localPlayer = player;
        this.localMobs = players;

        if (!this.isConnected) {
            return;
        }

        if (Date.now() - this.lastPingToRoomService > ROOM_SERVICE_PING_INTERVAL && this.thisIsTheHostServer) {
            this.accessRoomService(this.game.serverSettings.getAccessPassword());
        }
        if (Date.now() - this.lastMapRequest > MAP_REQUEST_INTERVAL && this.hostParticipantId) {
            this.lastMapRequest = Date.now();
            if (!this.thisIsTheHostServer && !this.hadMap) {
                // request the map
                console.log("Requesting Map");
                const data = JSON.stringify({ type: "requestMap" });
                this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE, [this.hostParticipantId.sid]);
            }
        }

        // need to send out an "I am the host message"
        if (Date.now() - this.lastHostUpdate > MAP_REQUEST_INTERVAL && this.thisIsTheHostServer) {
            this.lastHostUpdate = Date.now();
            const data = JSON.stringify({ type: "iAmHost", version: "_VERSION_" });
            this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.RELIABLE);
        }

        if (Date.now() - this.lastUpdate > UPDATE_INTERVAL_MS) {
            this.lastUpdate = Date.now();

            if (this.thisIsTheHostServer) {
                const data = JSON.stringify({ type: "mobs", host: true, data: players.map(mob => mob.getNetworkState()) });
                this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.LOSSY);
            } else {
                if (this.hostParticipantId) {
                    const data = JSON.stringify({ type: "mobs", host: false, data: [player.getNetworkState()] });
                    this.room.localParticipant.publishData(this.encoder.encode(data), DataPacket_Kind.LOSSY, [this.hostParticipantId.sid]);
                }
            }
        }
    }
}

