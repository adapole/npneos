import express, { Application, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import WalletConnect from '@walletconnect/node';
require('dotenv').config();
import WebSocket from 'ws';
import algosdk from 'algosdk';

const PORT = process.env.PORT || 3000;
const app: Application = express();
app.use(express.json());
app.use(express.static(__dirname + '/'));

async function getContractAPI(): Promise<algosdk.ABIContract> {
	const buff = fs.readFileSync('./d4t.json');

	return new algosdk.ABIContract(JSON.parse(buff.toString()));
}

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server: server });
app.get('/', (req: Request, res: Response, next: NextFunction) => {
	res.status(200).send('Hello World!');
});
app.get('/d4t', async (req: Request, res: Response, next: NextFunction) => {
	const contract = await getContractAPI();
	const appid = contract.networks['default'].appID;
	res.status(200).send(appid + '\n');
});

server.listen(PORT, () => {
	console.log(`Server started on port ${PORT}`);
});

console.log('websocket server created');

wss.on('connection', function (ws) {
	var id = setInterval(function () {
		ws.send(JSON.stringify(new Date()), function () {});
	}, 1000);

	console.log('websocket connection open');

	ws.on('close', function () {
		console.log('websocket connection close');
		clearInterval(id);
	});
});
