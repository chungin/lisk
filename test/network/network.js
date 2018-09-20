/*
 * Copyright © 2018 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

'use strict';

const childProcess = require('child_process');
const utils = require('./utils');
const shell = require('./setup/shell');
const config = require('./setup/config');
const waitUntilBlockchainReady = require('../common/utils/wait_for')
	.blockchainReady;

const NODE_FINISHED_SYNC_REGEX = /Finished sync/;
const NODE_FINISHED_SYNC_TIMEOUT = 40000;
const PM2_MAX_LOG_LINES = 10000;
const WAIT_BEFORE_CONNECT_MS = 20000;

const getPeersStatus = peers => {
	return Promise.all(
		peers.map(peer => {
			return utils.http.getNodeStatus(peer.httpPort, peer.ip);
		})
	);
};

const getMaxAndAvgHeight = peerStatusList => {
	let maxHeight = 1;
	let heightSum = 0;
	const totalPeers = peerStatusList.length;
	peerStatusList.forEach(peerStatus => {
		if (peerStatus.height > maxHeight) {
			maxHeight = peerStatus.height;
		}
		heightSum += peerStatus.height;
	});

	return {
		maxHeight,
		averageHeight: heightSum / totalPeers,
	};
};

class Network {
	constructor(configurations) {
		this.configurations = configurations;
		this.sockets = [];
	}

	establishMonitoringSocketsConnections() {
		return new Promise((resolve, reject) => {
			utils.ws.establishWSConnectionsToNodes(
				this.configurations,
				(err, socketsResult) => {
					if (err) {
						return reject(err);
					}
					this.sockets = socketsResult;
					resolve(socketsResult);
				}
			);
		});
	}

	killMonitoringSocketsConnections() {
		return new Promise((resolve, reject) => {
			utils.ws.killMonitoringSockets(this.sockets, err => {
				if (err) {
					return reject(err);
				}
				resolve();
			});
		});
	}

	// TODO 2: Rename to launchNetwork or just launch
	createNetwork() {
		return Promise.resolve()
			.then(() => {
				return this.generatePM2JSON();
			})
			.then(() => {
				return this.recreateDatabases();
			})
			.then(() => {
				return this.clearAllLogs();
			})
			.then(() => {
				return this.launchTestNodes();
			})
			.then(() => {
				return this.waitForAllNodesToBeReady();
			})
			.then(() => {
				return this.enableForgingForDelegates();
			})
			.then(() => {
				return this.establishMonitoringSocketsConnections();
			})
			.then(() => {
				return new Promise((resolve, reject) => {
					utils.logger.log(
						`Waiting ${WAIT_BEFORE_CONNECT_MS /
							1000} seconds for nodes to establish connections`
					);
					setTimeout(err => {
						if (err) {
							return reject(err);
						}
						resolve();
					}, WAIT_BEFORE_CONNECT_MS);
				});
			});
	}

	generatePM2JSON() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Generating PM2 configuration');
			config.generatePM2json(this.configurations, (err, pm2JSON) => {
				if (err) {
					return reject(err);
				}
				resolve(pm2JSON);
			});
		});
	}

	recreateDatabases() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Recreating databases');
			// TODO 2: Require shell
			shell.recreateDatabases(this.configurations, err => {
				if (err) {
					return reject(err);
				}
				resolve();
			});
		});
	}

	clearAllLogs() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Clearing existing logs');
			shell.clearLogs(err => {
				if (err) {
					return reject(err);
				}
				resolve();
			});
		});
	}

	launchTestNodes() {
		return new Promise((resolve, reject) => {
			utils.logger.log('Launching network');
			shell.launchTestNodes(err => {
				if (err) {
					return reject(err);
				}
				resolve();
			});
		});
	}

	killNetwork() {
		return Promise.resolve()
			.then(() => {
				return new Promise((resolve, reject) => {
					utils.logger.log('Shutting down network');
					shell.killTestNodes(err => {
						if (err) {
							return reject(err);
						}
						resolve();
					});
				});
			})
			.then(() => {
				return this.killMonitoringSocketsConnections();
			});
	}

	waitForAllNodesToBeReady() {
		utils.logger.log('Waiting for nodes to load the blockchain');

		const retries = 20;
		const timeout = 3000;

		const nodeReadyPromises = this.configurations.map((configuration) => {
			return new Promise((resolve, reject) => {
				waitUntilBlockchainReady( // TODO 2: Require; see other network.js
					(err) => {
						if (err) {
							return reject(err);
						}
						resolve();
					},
					retries,
					timeout,
					`http://${configuration.ip}:${configuration.httpPort}`
				);
			});
		});

		return Promise.all(nodeReadyPromises);
	}

	enableForgingForDelegates() {
		utils.logger.log('Enabling forging with registered delegates');

		const enableForgingPromises = [];
		this.configurations.forEach(configuration => {
			configuration.forging.delegates.map(keys => {
				if (!configuration.forging.force) {
					const enableForgingPromise = utils.http.enableForging(
						keys,
						configuration.httpPort
					);
					enableForgingPromises.push(enableForgingPromise);
				}
			});
		});
		return Promise.all(enableForgingPromises)
			.then(forgingResults => {
				const someFailures = forgingResults.some(forgingResult => {
					return !forgingResult.forging;
				});
				if (someFailures) {
					throw new Error('Enabling forging failed for some of delegates');
				}
			});
	}

 	// TODO 2: Find a way to not have to pass sockets as argument
	getAllPeers() {
		return Promise.all(
			this.sockets.map(socket => {
				if (socket.state === 'open') {
					return socket.call('list', {});
				}
			})
		);
	}

	waitForNodeToSync(nodeName) {
		return new Promise((resolve, reject) => {
			const pm2LogProcess = childProcess.spawn('node_modules/.bin/pm2', [
				'logs',
				'--lines',
				PM2_MAX_LOG_LINES,
				nodeName,
			]);

			const nodeReadyTimeout = setTimeout(() => {
				pm2LogProcess.stdout.removeAllListeners('data');
				pm2LogProcess.removeAllListeners('error');
				reject(new Error(`Node ${nodeName} failed to sync before timeout`));
			}, NODE_FINISHED_SYNC_TIMEOUT);

			pm2LogProcess.once('error', err => {
				clearTimeout(nodeReadyTimeout);
				pm2LogProcess.stdout.removeAllListeners('data');
				reject(new Error(`Node ${nodeName} failed to sync: ${err.message}`));
			});
			pm2LogProcess.stdout.on('data', data => {
				const dataString = data.toString();
				// Make sure that all nodes have fully synced before we
				// run the test cases.
				if (NODE_FINISHED_SYNC_REGEX.test(dataString)) {
					clearTimeout(nodeReadyTimeout);
					pm2LogProcess.stdout.removeAllListeners('error');
					pm2LogProcess.stdout.removeAllListeners('data');
					resolve();
				}
			});
		});
	}

	waitForAllNodesToSync(nodeNamesList) {
		const waitForSyncPromises = nodeNamesList.map(nodeName => {
			return this.waitForNodeToSync(nodeName);
		});
		return Promise.all(waitForSyncPromises);
	}

	clearLogs(nodeName) {
		return new Promise((resolve, reject) => {
			// TODO: Once we upgrade pm2 to a version which supports passing a nodeName
			// to the pm2 flush command, we should use that instead of removing the
			// log files manually. Currently pm2 flush clears the logs for all nodes.
			const sanitizedNodeName = nodeName.replace(/_/g, '-');
			childProcess.exec(`rm -rf test/network/logs/lisk-test-${sanitizedNodeName}.*`, err => {
				if (err) {
					return reject(
						new Error(`Failed to clear logs for node ${nodeName}: ${err.message}`)
					);
				}
				resolve();
			});
		});
	}

	stopNode(nodeName) {
		return new Promise((resolve, reject) => {
			childProcess.exec(`node_modules/.bin/pm2 stop ${nodeName}`, err => {
				if (err) {
					return reject(
						new Error(`Failed to stop node ${nodeName}: ${err.message}`)
					);
				}
				resolve();
			});
		});
	}

	startNode(nodeName, waitForSync) {
		let startPromise = new Promise((resolve, reject) => {
			childProcess.exec(`node_modules/.bin/pm2 start ${nodeName}`, err => {
				if (err) {
					return reject(
						new Error(`Failed to start node ${nodeName}: ${err.message}`)
					);
				}
				resolve();
			});
		});
		if (waitForSync) {
			startPromise = startPromise.then(() => {
				return this.waitForNodeToSync(nodeName).catch(err => {
					throw new Error(`Failed to start node ${nodeName} because it did not sync before timeout`);
				});
			});
		}
		return startPromise;
	}

	restartNode(nodeName, waitForSync) {
		return this.stopNode(nodeName)
			.then(() => {
				return this.startNode(nodeName, waitForSync);
			});
	}

	restartAllNodes(nodeNamesList, waitForSync) {
		const waitForRestartPromises = nodeNamesList.map(nodeName => {
			return this.restartNode(nodeName, waitForSync);
		});
		return Promise.all(waitForRestartPromises);
	}

	getNodesStatus() {
		return this.getAllPeers(this.sockets)
			.then(peers => {
				return getPeersStatus(peers);
			})
			.then(peerStatusList => {
				const peersCount = peerStatusList.length;
				const networkMaxAvgHeight = getMaxAndAvgHeight(peerStatusList);
				const status = {
					peersCount,
					peerStatusList,
					networkMaxAvgHeight,
				};
				return status;
			});
	}
}

module.exports = Network;
