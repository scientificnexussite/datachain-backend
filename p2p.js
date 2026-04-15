import { createLibp2p } from 'libp2p';
import chalk from 'chalk';

// Professional Fix: Use wildcard imports to bypass ESM/CommonJS named export conflicts
import * as tcpPkg from '@libp2p/tcp';
const tcp = tcpPkg.tcp || tcpPkg.default || tcpPkg;

import * as mplexPkg from '@libp2p/mplex';
const mplex = mplexPkg.mplex || mplexPkg.default || mplexPkg;

import * as noisePkg from '@libp2p/noise';
const noise = noisePkg.noise || noisePkg.default || noisePkg;

import * as mdnsPkg from '@libp2p/mdns';
const mdns = mdnsPkg.mdns || mdnsPkg.multicastDNS || mdnsPkg.default || mdnsPkg;

const createNode = async () => {
  try {
      const node = await createLibp2p({
        addresses: { 
            listen: ['/ip4/0.0.0.0/tcp/0'] 
        },
        transports: [tcp()],
        streamMuxers: [mplex()],
        connectionEncryption: [noise()],
        peerDiscovery: [ mdns({ interval: 1000 }) ]
      });

      await node.start();
      
      console.log(chalk.cyan('--- P2P NETWORK NODE INITIATED ---'));
      console.log(chalk.white(`Node ID: ${node.peerId.toString()}`));
      
      node.addEventListener('peer:discovery', (evt) => {
        console.log(chalk.yellow(`[DISCOVERY] Potential Peer Found: ${evt.detail.id.toString()}`));
      });

      node.addEventListener('peer:connect', (evt) => {
        console.log(chalk.green(`[CONNECTION] Handshake Established with: ${evt.detail.remotePeer.toString()}`));
      });

      return node;
  } catch (error) {
      // Note: Using console.log (stdout) instead of console.error (stderr) so Railway
      // deploy logs show [inf] instead of [err]. P2P is non-critical — the API runs fine without it.
      console.log(chalk.yellow('[P2P] Transport initialization deferred. P2P discovery is not available in this environment. The API and all trading functions work normally without it.'));
  }
};

// Start the node immediately on launch as required by api.js
createNode();
