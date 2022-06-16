import express, { Application, Request, Response, NextFunction } from 'express';
import WalletConnect from '@walletconnect/node';
require('dotenv').config();
import WebSocket from 'ws';

const PORT = process.env.PORT || 3000;
const app: Application = express();
app.use(express.json());
app.use(express.static(__dirname + '/'));

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server: server });
app.get('/', (req: Request, res: Response, next: NextFunction) => {
	res.status(200).send('Hello World!');
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
