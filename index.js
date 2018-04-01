var crypto = require('crypto');
var rp = require('request-promise');
const BitMEXClient = require('bitmex-realtime-api');


var GlobalParameters = {
    isBuy : () => true,
    qty: () => 1,
    padding: () => 0.0,
    needToFill: () => 12,
    pauseTime: () => 2100,

    //////////////////////////////////////////////////////////////
    isSell : () => !GlobalParameters.isBuy(),
    sideSign: () => (1*(!!GlobalParameters.isBuy()) + (-1)*(!!GlobalParameters.isSell())),
};

const apiKey = "QwTwTXGgadLYh4kpLVIPv8tY";
const apiSecret = "kx3zOkTmkVzxbzHzA2272UVb7GFGVFWG30ngfTMFRpHEyBEd";

const client = new BitMEXClient({
    testnet: true, // set `true` to connect to the testnet site (testnet.bitmex.com)
    // Set API Key ID and Secret to subscribe to private streams.
    // See `Available Private Streams` below.
    apiKeyID: apiKey,
    apiKeySecret: apiSecret,
    maxTableLen: 10000  // the maximum number of table elements to keep in memory (FIFO queue)
  });

var orderDeleteAllRequest = (param) => orderRequest('DELETE','/api/v1/order/all', param);
var orderPostRequest = (param) => orderRequest('POST','/api/v1/order', param);
var orderRequest = (verb, path, param) => {
    var expires = new Date().getTime() + (60 * 1000), // 1 min in the future
    data = param;

    // Pre-compute the postBody so we can be sure that we're using *exactly* the same body in the request
    // and in the signature. If you don't do this, you might get differently-sorted keys and blow the signature.
    var postBody = JSON.stringify(data);

    var signature = crypto.createHmac('sha256', apiSecret).update(verb + path + expires + postBody).digest('hex');

    var headers = {
    'content-type' : 'application/json',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    // This example uses the 'expires' scheme. You can also use the 'nonce' scheme. See
    // https://www.bitmex.com/app/apiKeysUsage for more details.
    'api-expires': expires,
    'api-key': apiKey,
    'api-signature': signature
    };

    return {
    headers: headers,
    url:'https://testnet.bitmex.com'+path,
    method: verb,
    body: postBody
    };
}


var CurrentState = {
    
    priceField: null,
    //orderById: {}, 
    latestSentTime: null, 
    isOrderUpdateIsScheduled: false, 
    isOrderDataArrived: false,
    isFillingCompleteFlag: false,    
    isExitRequested: false,
    totalOrderQtyField: 0,

    filledOrdersById: {},
    

    getPrice: () => {
        return CurrentState.priceField;
    },

    setPrice: (newPrice, quote) => {
        if (CurrentState.getPrice() != newPrice)
        {
            console.log('quote price:', newPrice,'quote:', quote);
            CurrentState.priceField = newPrice;
            tryPostOrder();
        }
    },

    isSafeToTrade: () => {
        return !!CurrentState.isOrderDataArrived
        && !!CurrentState.priceField  
        && CurrentState.totalOrderQty() !== 1
        && !CurrentState.isOrderUpdateIsScheduled
        && !CurrentState.isFillingComplete()
        && !CurrentState.isExitRequested;
    },

    isFillingComplete: ()=> {
        return !!CurrentState.isFillingCompleteFlag && CurrentState.isFillingCompleteFlag;
    },

    totalOrderQty: () => {
        // let sm = 0;
        // for (var key in CurrentState.orderById) {
        //     // skip loop if the property is from prototype
        //     if (!CurrentState.orderById.hasOwnProperty(key)) continue;
        //     sm += CurrentState.orderById[key].orderQty;
        // }
        // return sm;
        return CurrentState.totalOrderQtyField;
    },


    updateCurrentStateFromOrderData: data => {
        CurrentState.isOrderDataArrived = true;
        data.forEach(dataOrder => console.log(dataOrder));
        let newOrders = 0;
        data.forEach(anOrder => {
            if (anOrder.ordStatus === 'New') {
                newOrders += anOrder.orderQty;
            }
            if (anOrder.ordStatus === 'Filled') {
                CurrentState.filledOrdersById[anOrder.orderID] = anOrder.orderQty;
            }
        });
        
        let filled = 0;
        for(let id in CurrentState.filledOrdersById){
            if (CurrentState.filledOrdersById.hasOwnProperty(id)){
                filled += CurrentState.filledOrdersById[id];
            }
        }
        // HACK: we stop filling before last order has been filled, to avoid potential losses...
        if (GlobalParameters.needToFill() - GlobalParameters.qty <= filled)
        {
            CurrentState.isFillingCompleteFlag = true;
            doExit();
        }

        CurrentState.totalOrderQtyField = newOrders;       
        if (newOrders !== 1)
        {
            tryPostOrder();
        }


    },

    getAndUpdateWaitingTime: () => {       
        let time =  !CurrentState.latestSentTime ? 0 : Math.max(0, CurrentState.latestSentTime + GlobalParameters.pauseTime() - CurrentState.now());
        CurrentState.latestSentTime = CurrentState.now();
        console.log('getAndUpdateWaitingTime:', time);
        return time;
    },

    now: () => Date.now(),

}


var doExit = () =>{
    console.log('Exit requested...')
    CurrentState.isExitRequested = true;

    setTimeout(() =>{
        rp(orderDeleteAllRequest({})).then(response => {
            console.log("delete Ok:", response);
        }).catch(error => {
            console.log("delete error:", error);
        });
    }, 
    CurrentState.getAndUpdateWaitingTime());

    // TODO: dont know how to close sockets...

}


client.addStream('XBTUSD', 'order', function (data, symbol, tableName) {
    CurrentState.updateCurrentStateFromOrderData(data);

    if (!data.length) return;
    const order = data[data.length - 1]; 
    console.log('last order.text: ', order.text,'data.length:', data.length);
   
});

client.addStream('XBTUSD', 'quote', function (data, symbol, tableName) {
    if (!data.length) return;
    const quote = data[data.length - 1];  // the last data element is the newest quote
    // Do something with the quote (.bidPrice, .bidSize, .askPrice, .askSize)

    let receivedPrice = GlobalParameters.isBuy() ? quote.bidPrice : quote.bidPrice;

    CurrentState.setPrice(receivedPrice,quote);     

  });

var tryPostOrder = () => {
       
    if (!CurrentState.isSafeToTrade())
    {
        if (CurrentState.isFillingComplete())
        {
            console.log(GlobalParameters.needToFill(),' has been filled. Complete!' );
        }
        return;
    }  

    CurrentState.isOrderUpdateIsScheduled = true;
    setTimeout(() =>{
            rp(orderDeleteAllRequest({})).then(response => {
                console.log("delete Ok:", response);
                setTimeout( () => {
                    rp(orderPostRequest({
                    symbol:"XBTUSD",
                    orderQty: GlobalParameters.sideSign() * GlobalParameters.qty(),
                    price: CurrentState.getPrice() + (-1) * GlobalParameters.sideSign() * GlobalParameters.padding(),
                    ordType:"Limit",
                    })).then(response => {
                        console.log("post Ok:", response);

                        // HACK: to make sure order stays pause time on the stock
                        CurrentState.latestSentTime = CurrentState.now();

                        CurrentState.isOrderUpdateIsScheduled = false;
                        // if (!CurrentState.orderById[response.orderID]) CurrentState.orderById[response.orderID] = {};
                        // CurrentState.orderById[response.orderID].orderQty = response.orderQty;
                        tryPostOrder();
                    }).catch(error => {
                        console.log("post error:", error);
                    });
                },
                CurrentState.getAndUpdateWaitingTime());
            }).catch(error => {
                console.log("delete error:", error);
            });
        }, 
        CurrentState.getAndUpdateWaitingTime());
  };

  client.on('initialize', () => {
    console.log('initialize:',client.streams);  // Log .public, .private and .all stream names
  });

  client.on('open', () => {
    console.log('open:',client.streams);  // Log .public, .private and .all stream names
  });

  client.on('error', error => {
    console.log('error:',client.streams,'; error:', error);  // Log .public, .private and .all stream names
    doExit();
  });

  client.on('close', () => {
    console.log('close:',client.streams);  // Log .public, .private and .all stream names
    doExit();
  });
  
