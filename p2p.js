import { WebSocket } from 'ws';
import chalk from 'chalk';
import mempool from './mempool.js';

let sockets = [];

export const initP2P = (wss, nexusChain) => {
    // 1. Listen for incoming connections from other Nodes
    wss.on('connection', (ws) => {
        initConnection(ws, nexusChain, 'Incoming');
    });

    // 2. Dial out to peer URLs defined in Railway Environment Variables
    if (process.env.PEERS) {
        const peers = process.env.PEERS.split(',');
        peers.forEach(peerUrl => {
            connectToPeer(peerUrl.trim(), nexusChain);
        });
    }
    
    console.log(chalk.cyan.bold('--- P2P GOSSIP PROTOCOL INITIATED ---'));
};

const connectToPeer = (peerUrl, nexusChain) => {
    try {
        // Automatically route traffic through standard web ports
        const wsUrl = peerUrl.replace(/^http/, 'ws');
        const ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            console.log(chalk.green(`[P2P] Connected to peer: ${wsUrl}`));
            initConnection(ws, nexusChain, 'Outgoing');
        });
        
        ws.on('error', () => {
            console.log(chalk.yellow(`[P2P] Connection failed: ${wsUrl}. Retrying in 10s...`));
            setTimeout(() => connectToPeer(peerUrl, nexusChain), 10000);
        });
    } catch (e) {
        console.log(chalk.red(`[P2P] Invalid Peer URL: ${peerUrl}`));
    }
};

const initConnection = (ws, nexusChain, direction) => {
    sockets.push(ws);

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            
            // If another node announces a new block, immediately ask them for a copy
            if (msg.event === 'NEW_BLOCK') {
                ws.send(JSON.stringify({ type: 'QUERY_ALL' }));
                return;
            }

            // P2P Protocol Engine
            switch (msg.type) {
                case 'QUERY_LATEST':
                    ws.send(JSON.stringify({ type: 'RESPONSE_BLOCKCHAIN', data: [nexusChain.getLatestBlock()] }));
                    break;
                case 'QUERY_ALL':
                    ws.send(JSON.stringify({ type: 'RESPONSE_BLOCKCHAIN', data: nexusChain.chain }));
                    break;
                case 'RESPONSE_BLOCKCHAIN':
                    handleBlockchainResponse(msg.data, nexusChain);
                    break;
                case 'BROADCAST_TX':
                    // If a peer sends a new transaction, verify it, add to mempool, and gossip it further
                    if (await mempool.addTransaction(msg.data)) {
                        console.log(chalk.magenta(`[P2P] Received and propagating new transaction.`));
                        broadcastP2P({ type: 'BROADCAST_TX', data: msg.data }); 
                    }
                    break;
            }
        } catch (e) {
            // Ignore malformed network noise
        }
    });

    ws.on('close', () => {
        sockets = sockets.filter(s => s !== ws);
    });

    // The second we connect, ask the peer what block they are currently on
    ws.send(JSON.stringify({ type: 'QUERY_LATEST' }));
};

const handleBlockchainResponse = async (receivedBlocks, nexusChain) => {
    if (!receivedBlocks || receivedBlocks.length === 0) return;

    const latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    const latestBlockHeld = nexusChain.getLatestBlock();

    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log(chalk.yellow(`[P2P] Peer chain is longer (${latestBlockReceived.index} vs ${latestBlockHeld.index}). Syncing...`));
        
        if (receivedBlocks.length === 1) {
            console.log(chalk.yellow('[P2P] Requesting full chain history from peer...'));
            broadcastP2P({ type: 'QUERY_ALL' });
        } else {
            console.log(chalk.green('[P2P] Full chain received. Attempting consensus reorganization...'));
            // This safely overwrites the empty local DB with the true global history
            await nexusChain.resolveConflict(receivedBlocks);
        }
    } else {
        console.log(chalk.gray(`[P2P] Peer chain length is equal or shorter. No sync needed.`));
    }
};

export const broadcastP2P = (message) => {
    sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
};
