import express, { Application, Request, Response, NextFunction } from 'express';
require('dotenv').config();
import WebSocket from 'ws';
import { apiGetAccountAssets, ChainType, getContractAPI } from './algodfunct';

const PORT = process.env.PORT || 3000;
const app: Application = express();
(BigInt.prototype as any).toJSON = function () {
	return this.toString();
};
app.use(express.json());
app.use(express.static(__dirname + '/'));

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
