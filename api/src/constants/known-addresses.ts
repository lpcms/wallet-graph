// ===== ИЗВЕСТНЫЕ АДРЕСА ETHEREUM MAINNET =====
// Категория определяет цвет узла в графе (легенда «Владелец»).
// Адреса бирж и протоколов (SERVICE_ADDRESSES) не участвуют в кластеризации, 2-м хопе
// и капитализации: через них проходят деньги тысяч посторонних пользователей.

// WALLET — обычный кошелёк; UNATTRIBUTED — контракт или сервисный кошелёк без известного владельца
export type EntityType = 'WALLET' | 'CEX' | 'DEX' | 'FUND' | 'DEFI' | 'ISSUER' | 'PERSON' | 'UNATTRIBUTED'

export interface KnownEntity {
  name: string
  type: EntityType
}

const ENTRIES: [address: string, name: string, type: EntityType][] = [
  // Централизованные биржи
  ['0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', 'Binance', 'CEX'],
  ['0xd551234ae421e3bcba99a0da6d736074f22192ff', 'Binance 2', 'CEX'],
  ['0x564286362092d8e7936f0549571a803b203aaced', 'Binance 3', 'CEX'],
  ['0x0681d8db095565fe8a346fa0277bffde9c0edbbf', 'Binance 4', 'CEX'],
  ['0xfe9e8709d3215310075d67e3ed32a380ccf451c8', 'Binance 5', 'CEX'],
  ['0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67', 'Binance 6', 'CEX'],
  ['0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', 'Binance 7', 'CEX'],
  ['0xf977814e90da44bfa03b6295a0616a897441acec', 'Binance 8', 'CEX'],
  ['0x001866ae5b3de6caa5a51543fd9fb64f524f5478', 'Binance 9', 'CEX'],
  ['0x85b931a32a0725be14285b66f1a22178c672d69b', 'Binance 10', 'CEX'],
  ['0x708396f17127c42383e3b9014072679b2f60b82f', 'Binance 11', 'CEX'],
  ['0xe0f0cfde7ee664943906f17f7f14342a76a3b760', 'Binance 12', 'CEX'],
  ['0x8f22f2063d253846b53609231ed80fa571bc0c8f', 'Binance 13', 'CEX'],
  ['0x28c6c06298d514db089934071355e5743bf21d60', 'Binance 14', 'CEX'],
  ['0x21a31ee1afc51d94c2efccaa2092ad1028285549', 'Binance 15', 'CEX'],
  ['0x71660c4005ba85c37ccec55d0c4493e66fe775d3', 'Coinbase', 'CEX'],
  ['0x503828976d22510aad0201ac7ec88293211d23da', 'Coinbase 2', 'CEX'],
  ['0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740', 'Coinbase 3', 'CEX'],
  ['0x3cd751e6b0078be393132286c442345e5dc49699', 'Coinbase 4', 'CEX'],
  ['0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511', 'Coinbase 5', 'CEX'],
  ['0xeb2629a2734e272bcc07bda959863f316f4bd4cf', 'Coinbase 6', 'CEX'],
  ['0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', 'Coinbase 7', 'CEX'],
  ['0x77696bb39917c91a0c3d2f859fd351c42a5a79ac', 'Coinbase 8', 'CEX'],
  ['0x7c195d981abfdc3ddecd2ca0fed0958430488e34', 'Coinbase 9', 'CEX'],
  ['0x95a9bd206ae52c4ba8eecfc93d18eebfef04902c', 'Coinbase 10', 'CEX'],
  ['0x2910543af39aba0cd09dbb2d50200b3e800a63d2', 'Kraken', 'CEX'],
  ['0xcef4c6c7af5c6efbc28d0f82de1f4dce22ee1e1c', 'Kraken 2', 'CEX'],
  ['0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', 'Kraken 3', 'CEX'],
  ['0xfa52274dd61e1643d2205169732f29114bc240b3', 'Kraken 4', 'CEX'],
  ['0x53d284357ec70ce289d6d64134dfac8e511c8a3d', 'Kraken 5', 'CEX'],
  ['0x89e51fa8ca5d66cd220baed62ed01e8951aa7c40', 'Kraken 6', 'CEX'],
  ['0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', 'OKX', 'CEX'],
  ['0x236f9f97e0e62388479bf9e5ba4889e46b0273c3', 'OKX 2', 'CEX'],
  ['0xa7efae728d2936e78bda97dc267687568dd593f3', 'OKX 3', 'CEX'],
  ['0xabd4c63d2616a5201454168269031355f4764337', 'Huobi', 'CEX'],
  ['0x6748f50f686bfbca6fe8ad62b22228b87f31ff2b', 'Huobi 2', 'CEX'],
  ['0xfdb16996831753d5331ff813c29a93c76834a0ad', 'Huobi 3', 'CEX'],
  ['0x46705dfff24256421a05d056c29e81bdc09723b8', 'Huobi 4', 'CEX'],
  ['0x32598293906b5b17c27d657db3ad2c9b3f3e4265', 'Huobi 5', 'CEX'],
  ['0x742d35cc6634c0532925a3b844bc454e4438f44e', 'Bitfinex', 'CEX'],
  ['0x876eabf441b2ee5b5b0554fd502a8e0600950cfa', 'Bitfinex 2', 'CEX'],
  ['0xd24400ae8bfebb18ca49be86258a3c749cf46853', 'Bitfinex 3', 'CEX'],
  ['0x2b5634c42055806a59e9107ed44d43c426e58258', 'KuCoin', 'CEX'],
  ['0xa1d8d972560c2f8144af871db508f0b0b10a3fbf', 'KuCoin 2', 'CEX'],
  ['0x689c56aef474df92d44a1b70850f808488f9769c', 'KuCoin 3', 'CEX'],
  ['0x6262998ced04146fa42253a5c0af90ca02dfd2a3', 'Crypto.com', 'CEX'],
  ['0x46340b20830761efd32832a74d7169b29feb9758', 'Crypto.com 2', 'CEX'],
  ['0x07ee55aa48bb72dcc6e9d78256648910de513eca', 'Gemini', 'CEX'],
  ['0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8', 'Gemini 2', 'CEX'],
  // Децентрализованные биржи: роутеры, агрегаторы, пулы
  ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'Uniswap V2 Router', 'DEX'],
  ['0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3 Router', 'DEX'],
  ['0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'Uniswap V3 Router 2', 'DEX'],
  ['0x1111111254fb6c44bac0bed2854e76f90643097d', '1inch v4', 'DEX'],
  ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch v5', 'DEX'],
  ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Protocol', 'DEX'],
  ['0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f', 'SushiSwap Router', 'DEX'],
  ['0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', 'Uniswap Universal Router', 'DEX'],
  ['0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', 'Uniswap Universal Router (old)', 'DEX'],
  ['0x000000000004444c5dc75cb358380d2e3de08a90', 'Uniswap V4 PoolManager', 'DEX'],
  ['0x111111125421ca6dc452d289314280a0f8842a65', '1inch v6', 'DEX'],
  ['0xdef171fe48cf0115b1d80b88dc8eab59176fee57', 'ParaSwap Augustus V5', 'DEX'],
  ['0x9008d19f58aabd9ed0d60971565aa8510560ab41', 'CoW Protocol Settlement', 'DEX'],
  ['0xba12222222228d8ba445958a75a0704d566bf2c8', 'Balancer V2 Vault', 'DEX'],
  ['0xdc24316b9ae028f1497c275eb9192a3ea0f67022', 'Curve stETH/ETH Pool', 'DEX'],
  // DeFi-протоколы: кредитование, стейкинг, обёртки
  ['0x00000000219ab540356cbb839cbe05303d7705fa', 'ETH2 Deposit Contract', 'DEFI'],
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'WETH Contract', 'DEFI'],
  ['0xae7ab96520de3a18e5e111b5eaab095312d7fe84', 'Lido stETH', 'DEFI'],
  ['0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9', 'Aave V2 LendingPool', 'DEFI'],
  ['0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', 'Aave V3 Pool', 'DEFI'],
  ['0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5', 'Compound cETH', 'DEFI'],
  ['0x0000000000a39bb272e79075ade125fd351887ac', 'Blur Pool', 'DEFI'],
  // Фонды и маркет-мейкеры
  ['0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae', 'Ethereum Foundation', 'FUND'],
  ['0x0000006daea1723962647b7e189d311d757fb793', 'Wintermute', 'FUND'],
  ['0xf584f8728b874a6a5c7a8d4d387c9aae9172d621', 'Jump Trading', 'FUND'],
  // Эмитенты токенов
  ['0x5754284f345afc66a98fbb0a0afe71e0f007b949', 'Tether Treasury', 'ISSUER'],
  // Известные персоны
  ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'Vitalik Buterin', 'PERSON'],
  ['0x3ddfa8ec3052539b6c9549f12cea2c295cff5296', 'Justin Sun', 'PERSON'],
]

export const KNOWN_ADDRESSES = new Map<string, KnownEntity>(ENTRIES.map(([address, name, type]) => [address, { name, type }]))

const SERVICE_TYPES: EntityType[] = ['CEX', 'DEX', 'DEFI']

// Биржи и протоколы: адрес → название
export const SERVICE_ADDRESSES = new Map<string, string>(
  ENTRIES.filter(([, , type]) => SERVICE_TYPES.includes(type)).map(([address, name]) => [address, name]),
)
