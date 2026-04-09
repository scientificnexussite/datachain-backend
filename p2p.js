import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { mplex } from '@libp2p/mplex';
import { noise } from '@libp2p/noise';
import { mdns } from '@libp2p/mdns';
import chalk from 'chalk';

const createNode = async () => {
  try {
      const node = await createLibp2p({
        addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
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
      console.error(chalk.red('[P2P ERROR] Failed to initialize node:'), error);
  }
};

createNode();
