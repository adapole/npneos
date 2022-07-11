import express, { Application, Request, Response, NextFunction } from 'express';
require('dotenv').config();
import WebSocket from 'ws';
import {
	apiGetAccountAssets,
	apiGetTxnParams,
	ChainType,
	getContractAPI,
	testNetClientalgod,
	testNetClientindexer,
} from './algodfunct';
import WalletConnect from '@walletconnect/client';
import { IInternalEvent } from '@walletconnect/types';
import { IWalletTransaction, SignTxnParams } from './types';
import { createClient } from 'redis';
import algosdk, { Transaction, TransactionSigner } from 'algosdk';
import { formatJsonRpcRequest } from '@json-rpc-tools/utils';

const PORT = process.env.PORT || 3000;
const app: Application = express();
(BigInt.prototype as any).toJSON = function () {
	return this.toString();
};
app.use(express.json());
app.use(express.static(__dirname + '/'));

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server: server });
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.log('Redis Client Error', err));

const DEFAULT_EXPIRATION = 3600;

const onSessionUpdate = async (accounts: string[]) => {
	const address = accounts[0];
	//await this.setState({ accounts, address });
	console.log(`onSessionUpdate: ${address}`);
	//await this.getAccountAssets();
	getAccountAssets(address, ChainType.TestNet);
};

const getAccountAssets = async (address: string, chain: ChainType) => {
	try {
		// get account balances
		const assets = await apiGetAccountAssets(chain, address);
		//await this.setStateAsync({ fetching: false, address, assets });
		console.log(`getAccountAssets: ${assets}`);
	} catch (error) {
		console.error(error);
		//await this.setStateAsync({ fetching: false });
	}
};
/* async function walletConnectSigner(
	txns: Transaction[],
	connector: WalletConnect | null,
	address: string
) {
	if (!connector) {
		console.log('No connector found!');
		return txns.map((tx) => {
			return {
				txID: tx.txID(),
				blob: new Uint8Array(),
			};
		});
	}
	const txnsToSign = txns.map((txn) => {
		const encodedTxn = Buffer.from(
			algosdk.encodeUnsignedTransaction(txn)
		).toString('base64');
		if (algosdk.encodeAddress(txn.from.publicKey) !== address)
			return { txn: encodedTxn, signers: [] };
		return { txn: encodedTxn };
	});
	// sign transaction
	const requestParams: SignTxnParams = [txnsToSign];

	const request = formatJsonRpcRequest('algo_signTxn', requestParams);
	//console.log('Request param:', request);
	const result: string[] = await connector.sendCustomRequest(request);

	//console.log('Raw response:', result);
	return result.map((element, idx) => {
		return element
			? {
					txID: txns[idx].txID(),
					blob: new Uint8Array(Buffer.from(element, 'base64')),
			  }
			: {
					txID: txns[idx].txID(),
					blob: new Uint8Array(),
			  };
	});
} */
/* function getSignerWC(
	connector: WalletConnect,
	address: string
): TransactionSigner {
	return async (txnGroup: Transaction[], indexesToSign: number[]) => {
		const txns = await Promise.resolve(
			walletConnectSigner(txnGroup, connector, address)
		);
		return txns.map((tx) => {
			return tx.blob;
		});
	};
} */
function convert(amount: number, decimals: number) {
	return amount * Math.pow(10, decimals);
}
async function atomic(
	connector: WalletConnect,
	address: string,
	xid: number,
	aamt: number,
	address2: string,
	xid2: number,
	aamt2: number
) {
	const suggestedParams = await apiGetTxnParams(ChainType.TestNet);
	await redisClient.connect();
	const wcStr = await redisClient.get(address2);
	await redisClient.QUIT();
	const wcSession = JSON.parse(wcStr!);
	console.log(wcSession.bridge);
	const connector2 = new WalletConnect({
		bridge: 'https://bridge.walletconnect.org', // Required
		clientMeta: {
			description: 'WalletConnect for DeFi4NFT; to Neos metaverse connection',
			url: 'https://defi4nft.herokuapp.com',
			icons: ['https://nodejs.org/static/images/logo.svg'],
			name: 'DeFi4NFT | Neos',
		},
		session: wcSession,
	});
	if (!connector2.connected) return console.log('NOT CONNECTED');
	//console.log(address2);
	/* const signer = getSignerWC(connector, address);
	const signer2 = getSignerWC(connector2, address2); */

	//const comp = new algosdk.AtomicTransactionComposer();

	let decimals = 6;
	if (xid !== 0)
		decimals = await testNetClientindexer
			.lookupAssetByID(xid)
			.do()
			.then((res) => {
				return res.asset.params['decimals'];
			})
			.catch((err) => {
				console.log(err);
				decimals = 6;
			});
	//console.log(assetInfo);
	//const decimal: number = assetInfo.asset.params['decimals'];
	let decimals2 = 6;
	if (xid2 !== 0)
		decimals2 = await testNetClientindexer
			.lookupAssetByID(xid2)
			.do()
			.then((res) => {
				return res.asset.params['decimals'];
			})
			.catch((err) => {
				console.log(err);
				decimals2 = 6;
			});

	const amt1 = convert(aamt, decimals);
	const amt2 = convert(aamt2, decimals2);

	let ptxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		from: address,
		to: address2,
		amount: amt1,
		suggestedParams,
	});
	if (xid !== 0) {
		ptxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
			from: address,
			to: address2,
			amount: amt1,
			assetIndex: xid,
			suggestedParams,
		});
	}

	let ptxn2 = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		from: address2,
		to: address,
		amount: amt2,
		suggestedParams,
	});
	if (xid2 !== 0) {
		ptxn2 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
			from: address2,
			to: address,
			amount: amt2,
			assetIndex: xid2,
			suggestedParams,
		});
	}

	let txns = [ptxn, ptxn2];
	//console.log(txns);
	// Group both transactions
	let txgroup = algosdk.assignGroupID(txns);
	//algosdk.assignGroupID(txns); //.map((toSign) => toSign)
	//console.log(txns);
	// Sign transaction
	const signed1 = await signTxn(txns, connector, address);
	const signed2 = await signTxn(txns, connector2, address2);

	//console.log(signed1);

	const sig1: SignedTxn = signed1.find(
		(txn) => txn.blob.length !== 0
	) as SignedTxn;
	const sig2: SignedTxn = signed2.find(
		(txn) => txn.blob.length !== 0
	) as SignedTxn;
	console.log(sig1.txID);
	console.log(sig2.txID);
	try {
		let tx = await testNetClientalgod
			.sendRawTransaction([sig1.blob, sig2.blob])
			.do();
		console.log('Transaction : ' + tx.txId);
		// Wait for transaction to be confirmed
		const confirmedTxn = await algosdk.waitForConfirmation(
			testNetClientalgod,
			tx.txId,
			4
		);
		//Get the completed Transaction
		console.log(
			'Transaction ' +
				tx.txId +
				' confirmed in round ' +
				confirmedTxn['confirmed-round']
		);
		return confirmedTxn['confirmed-round'];
	} catch (error) {
		console.log(error);
	}
}
async function signTxn(
	txns: Transaction[],
	connector: WalletConnect,
	address: string
): Promise<SignedTxn[]> {
	const txnsToSign = txns.map((txn) => {
		const encodedTxn = Buffer.from(
			algosdk.encodeUnsignedTransaction(txn)
		).toString('base64');

		if (algosdk.encodeAddress(txn.from.publicKey) !== address) {
			return { txn: encodedTxn, signers: [] };
		}
		return { txn: encodedTxn };
	});
	//console.log(txnsToSign);
	const request = formatJsonRpcRequest('algo_signTxn', [txnsToSign]);

	const result: string[] = await connector.sendCustomRequest(request);

	return result.map((element, idx) => {
		return element
			? {
					txID: txns[idx].txID(),
					blob: new Uint8Array(Buffer.from(element, 'base64')),
			  }
			: {
					txID: txns[idx].txID(),
					blob: new Uint8Array(),
			  };
	});
}
export interface SignedTxn {
	txID: string;
	blob: Uint8Array;
}
function makeJsonFromString(str: string) {
	const arr = str.split(',');
	if (arr.length < 1) return { type: str, values: {} };
	const type = arr[0];
	const xid = arr[1];
	const amt = arr[2];
	let camt = '';
	//if(arr.length > 3) {}
	if (type === 'borrow') {
		camt = arr[3];
	} else if (type === 'atomic') {
		return {
			type: type,
			values: {
				address: arr[1],
				xid: arr[2],
				aamt: arr[3],
				address2: arr[4],
				xid2: arr[5],
				aamt2: arr[6],
			},
		};
	}

	return { type: type, values: { xid, amt, camt } };
}

wss.on('connection', async function connection(ws: WebSocket) {
	console.log('connected new client');
	const walletConnector = new WalletConnect({
		bridge: 'https://bridge.walletconnect.org', // Required
		clientMeta: {
			description: 'Npneos-wallet; to Neos metaverse connection',
			url: 'https://npneos-wallet.herokuapp.com',
			icons: ['https://nodejs.org/static/images/logo.svg'],
			name: 'Np | Neos',
		},
	});

	ws.on('message', async function incoming(message: string) {
		const msg = message.toString();

		if (msg === 'i') {
		} else if (msg === 'wc') {
			try {
				// Check if connection is already established
				if (!walletConnector.connected) {
					// create new session
					walletConnector.createSession().then(() => {
						// get uri for QR Code modal
						const uri = walletConnector.uri;
						ws.send(uri);
						// encodeURIComponent
					});
				}
				// Subscribe to connection events
				walletConnector.on('connect', async (error, payload) => {
					if (error) {
						throw error;
					}

					// Close QR Code Modal
					const { accounts } = payload.params[0];
					const address = accounts[0];
					console.log(`onConnect: ${address}`);
					await redisClient.connect();
					await redisClient.setEx(
						address,
						DEFAULT_EXPIRATION,
						JSON.stringify(walletConnector.session)
					); //DEFAULT_EXPIRATION,
					await redisClient.QUIT();
					ws.send(address);
				});

				walletConnector.on('session_update', (error, payload) => {
					if (error) {
						throw error;
					}

					// Get updated accounts
					const { accounts } = payload.params[0];
					onSessionUpdate(accounts);
				});

				walletConnector.on('disconnect', (error, payload) => {
					if (error) {
						throw error;
					}
					// Delete walletConnector
					if (walletConnector) {
						//walletConnector.killSession();
						walletConnector.off;
					}
					walletConnector.connected = false;
				});
				if (walletConnector.connected) ws.send(walletConnector.accounts[0]);
			} catch (error) {
				console.error(error);
			}
		} else if (msg === 'address') {
			if (walletConnector.connected) {
				console.log('Address');
				ws.send(walletConnector.accounts[0]);
			}
		} else if (msg === 'optin') {
			if (walletConnector.connected) {
				console.log('optin');
				try {
					//await optinD4T(walletConnector, walletConnector.accounts[0]);
				} catch (error) {
					console.log(error);
				}
			}
		} else if (msg === 'close') {
			console.log('closing...');
			ws.close();
		}
		try {
			if (msg !== 'i' && msg !== 'wc' && msg !== 'address') {
				const jformat = makeJsonFromString(msg);
				console.log(jformat);
				if (jformat.type === 'extract') {
					if (walletConnector.connected) {
						try {
							if (jformat.values.xid) {
								let index = Math.abs(Number(jformat.values.xid));
								const assets = await apiGetAccountAssets(
									ChainType.TestNet,
									walletConnector.accounts[0]
								);
								if (assets.length < 1) index = 0;
								const at = index % assets.length;
								const returns = assets[at];
								ws.send(`0|${returns.id}:${returns.unitName};${returns.url}`);
							}
						} catch (error) {
							console.log(error);
						}
					}
				} else if (jformat.type === 'atomic') {
					if (walletConnector.connected) {
						console.log('atomic');
						try {
							if (
								jformat.values.xid &&
								jformat.values.aamt &&
								jformat.values.address2 &&
								jformat.values.xid2 &&
								jformat.values.aamt2
							) {
								const xid: number = Number(jformat.values.xid);
								const aamt: number = Number(jformat.values.aamt);
								const address2: string = jformat.values.address2;
								const xid2: number = Number(jformat.values.xid2);
								const aamt2: number = Number(jformat.values.aamt2);
								await atomic(
									walletConnector,
									walletConnector.accounts[0],
									xid,
									aamt,
									address2,
									xid2,
									aamt2
								);
							}
							/* wss.clients.forEach(async function each(client) {
						
						if (client !== ws && client.readyState === WebSocket.OPEN) {
							console.log(walletConnector.session);
							console.log(walletConnector.peerMeta);
						}
					}); */
						} catch (error) {
							console.log(error);
						}
					}
					/* let xid = 0;
					let j = xid;
					console.log('Herer');
					if (xid === 0) {
						j = 97927840;
					} else {
						j = 97931298;
					}
					try {
						//const assetInfo2 = await testNetClientindexer.lookupAssetByID(j).do();
						const decimals2 = await testNetClientalgod.getAssetByID(j).do();
						console.log('Here never');
						console.log(decimals2);
						//console.log(assetInfo2);
					} catch (error) {
						console.log(error);
					} */
				}
			}
		} catch (error) {}
	});
	ws.on('close', function close() {
		console.log('disconnected');
	});
});
app.get('/', (req: Request, res: Response, next: NextFunction) => {
	res.status(200).send('Hello World!');
});
app.get('/d4t', async (req: Request, res: Response, next: NextFunction) => {
	const contract = await getContractAPI();
	const appid = contract.networks['default'].appID;
	res.status(200).send(appid + '\n');
});
app.get('/assets', async (req: Request, res: Response, next: NextFunction) => {
	try {
		//const { data } = await axios.get(`https://api.chucknorris.io/jokes/random`);
		const assets = await apiGetAccountAssets(
			ChainType.TestNet,
			'BORRU26OCWXDSDEVY5I64L7HW7WXIAIOC4JPNRITTZWIUQKZDPGBXLGFT4'
		);

		res.status(200).send(assets);
	} catch (error) {
		next(error);
	}
});

server.listen(PORT, () => {
	console.log(`Server started on port ${PORT}`);
});

//console.log('websocket server created');

/* wss.on('connection', function (ws) {
	var id = setInterval(function () {
		ws.send(JSON.stringify(new Date()), function () {});
	}, 1000);

	console.log('websocket connection open');

	ws.on('close', function () {
		console.log('websocket connection close');
		clearInterval(id);
	});
}); */
