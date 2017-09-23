const async = require('async');
const base58 = require('bs58check');
const config = require('./config/config');
const fs = require('fs');
const moment = require('moment');
const mysql = require('mysql');
const request = require('request');
const util = require('util');
if (config.debug) {
    require('request-debug')(request);
}

// URLS
const howToUseUrl = 'https://reddit.com/r/lbry';
const baseUrl = 'https://oauth.reddit.com';
const rateUrl = 'https://api.lbry.io/lbc/exchange_rate';
const tokenUrlFormat = 'https://%s:%s@www.reddit.com/api/v1/access_token';
const txBaseUrl = 'https://explorer.lbry.io/tx';

// Other globals
const userAgent = 'lbryian/1.0.0 Node.js (by /u/lbryian)';
const commentKind = 't1';
const privateMessageKind = 't4';
let globalAccessToken;
let accessTokenTime;

// Load message templates
const messageTemplates = {};
const templateNames = [
    'onbalance',
    'ondeposit',
    'onsendtip',
    'onsendtip.insufficientfunds',
    'onsendtip.invalidamount',
    'onwithdraw',
    'onwithdraw.amountltefee',
    'onwithdraw.insufficientfunds',
    'onwithdraw.invalidaddress',
    'onwithdraw.invalidamount'
];
for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    messageTemplates[name] = fs.readFileSync(`templates/${name}.txt`, { encoding: 'utf8' }); 
}

// Connect to the database
let db;
const initSqlConnection = () => {
    const _db = mysql.createConnection({
        host: config.mariadb.host,
        user: config.mariadb.username,
        password: config.mariadb.password,
        database: config.mariadb.database,
        charset: 'utf8mb4',
        timezone: 'Z'
    });
    
    _db.on('error', (err) => {
        if (err.code === 2006 || ['PROTOCOL_CONNECTION_LOST', 'PROTOCOL_PACKETS_OUT_OF_ORDER', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'].indexOf(err.code) > -1) {
            _db.destroy();
            db = initSqlConnection();
        }
    });
    
    return _db;
};
db = initSqlConnection();

const loadAccessToken = (callback) => {
    if (fs.existsSync(config.accessTokenPath)) {
        const token = fs.readFileSync(config.accessTokenPath, { encoding: 'utf8' });
        return callback(null, String(token));
    }
    
    return callback(null, null);
};

const oauth = (callback) => {
    const url = util.format(tokenUrlFormat, config.clientId, config.clientSecret);
    request.post(url, { form: { grant_type: 'password', username: config.username, password: config.password} }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }

        let accessToken = null;
        try {
            const response = JSON.parse(body);
            accessToken = response.access_token;
            accessTokenTime = moment();
            if (accessToken && accessToken.trim().length > 0) {
                fs.writeFileSync(config.accessTokenPath, accessToken);
            }
        } catch (e) {
            return callback(e, null);
        }
        
        return callback(null, accessToken);
    });
};

const retrieveUnreadMessages = (accessToken, callback) => {
    const url = util.format('%s/message/unread?limit=100', baseUrl);
    request.get({ url: url, headers: { 'User-Agent': 'lbryian/1.0.0 Node.js (by /u/lbryian)', 'Authorization': 'Bearer ' + accessToken } }, (err, res, body) => {
         if (err) {
            console.log(err);
            return callback(err);
         }
         
         let response;
         try {
            response = JSON.parse(body);
         } catch (e) {
            return callback(e, null);
         }
         
         return callback(null, response.data.children);
    });
};

const createOrGetUserId = (username, callback) => {
    async.waterfall([
        (cb) => {
            db.query('SELECT Id FROM Users WHERE LOWER(Username) = ?', [username.toLowerCase()], cb);
        },
        (res, fields, cb) => {
            if (res.length === 0) {
                // user does not exist, create the user
                return cb(null, 0);
            }
            
            return cb(null, res[0].Id);
        },
        (userId, cb) => {
            if (userId === 0) {
                return db.query('INSERT INTO Users (Username, Created) VALUES (?, UTC_TIMESTAMP())', [username], (err, res) => {
                    if (err) {
                        console.log(err);
                        return cb(err, null);
                    }
                    
                    return cb(null, res.insertId);
                });
            }
            
            return cb(null, userId);
        }
    ], callback);
};

const getBalance = (userId, callback) => {
    db.query('SELECT Balance FROM Users WHERE Id = ?', [userId], (err, res) => {
        if (err) {
            return callback(err, null);
        }
        
        return callback(0, res.length === 0 ? 0 : res[0].Balance);
    });
};

const generateDepositAddress = (callback) => {
    request.post({ url: config.lbrycrd.rpcurl, json: { method: 'getnewaddress', params: [config.lbrycrd.account] } }, (err, resp, body) => {
        if (err || body.error) {
            return callback(err || body.error, null);
        }
        
        return callback(null, body.result);
    });
};

const getDepositAddress = (userId, callback) => {
    let newAddress = false;
    async.waterfall([
        (cb) => {
            db.query('SELECT DepositAddress FROM Users WHERE Id = ?', [userId], cb);
        },
        (res, fields, cb) => {
            const address = res.length > 0 ? res[0].DepositAddress : null;
            if (!address || address.trim().length === 0) {
                newAddress = true;
                return generateDepositAddress(cb);
            }
            return cb(null, address);
        },
        (address, cb) => {
            if (newAddress) {
                return db.query('UPDATE Users SET DepositAddress = ? WHERE Id = ?', [address, userId], (err) => {
                    if (err) {
                        return cb(err, null);
                    }
                    
                    return cb(null, address);
                });
            }
            
            return cb(null, address);
        }
    ], callback);
};

const sendTip = (sender, recipient, amount, tipdata, callback) => {
    console.log(`sending ${amount} LBC from ${sender} to ${recipient}`);
    
    const data = {};
    async.waterfall([
        (cb) => {
            // Start DB transaction
            db.beginTransaction((err) => {
                if (err) {
                    return cb(err, null);
                }
                return cb(null, true);
            });
        },
        (started, cb) => {
            // start a transaction
            // check the sender's balance
            createOrGetUserId(sender, cb);
        },
        (senderId, cb) => {
            data.senderId = senderId;
            getBalance(senderId, cb);
        },
        (senderBalance, cb) => {
            // balance is less than amount to tip, or the difference after sending the tip is negative
            if (senderBalance < amount || (senderBalance - amount) < 0) {
                return sendPMUsingTemplate('onsendtip.insufficientfunds', { how_to_use_url: howToUseUrl }, message.data.author, () => {
                    cb(new Error('Insufficient funds'), null);
                });
            }
            
            return db.query('UPDATE Users SET Balance = Balance - ? WHERE Id = ?', [amount, data.senderId], cb);
        },
        (res, fields, cb) => {
            // Update the recipient's balance
            createOrGetUserId(recipient, cb);
        },
        (recipientId, cb) => {
            data.recipientId = recipientId;
            db.query('UPDATE Users SET Balance = Balance + ? WHERE Id = ?', [amount, recipientId], cb);
        },
        (res, fields, cb) => {
            // save the message
            const msgdata = tipdata.message.data;
            db.query(   ['INSERT INTO Messages (AuthorId, Type, FullId, RedditId, ParentRedditId, Subreddit, Body, Context, RedditCreated, Created) ',
                         'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'].join(''),
                        [data.senderId,
                         tipdata.message.kind === privateMessageKind ? 1 : 2,
                         msgdata.name,
                         msgdata.id,
                         msgdata.parent_id,
                         msgdata.subreddit,
                         msgdata.body,
                         msgdata.context,
                         moment.utc(msgdata.created_utc * 1000).format('YYYY-MM-DD HH:mm:ss')
                        ], cb);
        },
        (res, fields, cb) => {
            console.log('Inserting tip.');
            // save the tip information
            db.query(   ['INSERT INTO Tips (MessageId, SenderId, RecipientId, Amount, AmountUsd, ParsedAmount, Created) ',
                         'VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'].join(''),
                        [res.insertId,
                         data.senderId,
                         data.recipientId,
                         amount,
                         tipdata.amountUsd,
                         tipdata.parsedAmount,
                        ], cb);
        },
        (res, fields, cb) => {
            // reply to the source message with message template after successful commit
            replyMessageUsingTemplate('onsendtip', { recipient: `u/${recipient}`, tip: `${amount} LBC ($${tipdata.amountUsd})`, how_to_use_url: howToUseUrl},
                                      tipdata.message.data.name, cb);
        },
        (success, cb) => {
            // Mark the message as read
            markMessageRead(tipdata.message.data.name, cb);
        },
        (success, cb) => {
            // commit the transaction
            db.commit((err) => {
                if (err) {
                    return cb(err, null);
                }
                
                return cb(null, true);
            });
        }
    ], (err) => {
        if (err) {
            console.log(err);
            return db.rollback(() => {
                callback(err, null);
            });
        }
        
        // success
        return callback(null, true);
    });
};

const convertUsdToLbc = (amount, callback) => {
    request.get({ url: rateUrl }, (err, res, body) => {
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        if (!response.data || !response.data.lbc_usd) {
            return callback(new Error('Could not retrieve the LBC/USD conversion rate.'));
        }
        
        const rateUsd = parseFloat(response.data.lbc_usd);
        if (isNaN(rateUsd) || rateUsd === 0) {
            return callback(new Error('Invalid LBC/USD rate retrieved.'));
        }
        const amountLbc = (amount / rateUsd).toFixed(8);
        return callback(null, amountLbc);
    });
};

const convertLbcToUsd = (amount, callback) => {
    request.get({ url: rateUrl }, (err, res, body) => {
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        if (!response.data || !response.data.lbc_usd) {
            return callback(new Error('Could not retrieve the LBC/USD conversion rate.'));
        }
        
        const rateUsd = parseFloat(response.data.lbc_usd);
        if (isNaN(rateUsd) || rateUsd === 0) {
            return callback(new Error('Invalid LBC/USD rate retrieved.'));
        }
        const amountLbc = (amount * rateUsd).toFixed(2);
        return callback(null, amountLbc);
    });
};

const markMessageRead = (messageFullId, callback) => {
    const url = `${baseUrl}/api/read_message`;
    request.post({ url, form: { id: messageFullId }, headers: { 'User-Agent': userAgent, 'Authorization': 'Bearer ' + globalAccessToken } }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }
        
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        // success
        return callback(null, true);
    });
};

const sendPMUsingTemplate = (template, substitions, subject, recipient, callback) => {
    if (!messageTemplates[template]) {
        return callback(new Error(`Message template ${template} not found.`));
    }
    
    let messageText = messageTemplates[template];
    console.log(messageText);
    for (let variable in substitutions) {
        if (substitutions.hasOwnProperty(variable)) {
            const re = new RegExp(['{', variable, '}'].join(''), 'ig');
            messageText = messageText.replace(re, substitutions[variable]);
        }
    }
    
    // send the message
    const url = `${baseUrl}/api/compose`;
    request.post({
                    url,
                    form: { api_type: 'json', text: messageText, subject, to: recipient },
                    headers: { 'User-Agent': userAgent, 'Authorization': 'Bearer ' + globalAccessToken }
                 }, (err, res, body) => {
                    if (err) {
                        return callback(err, null);
                    }
                    
                    let response;
                    try {
                        response = JSON.parse(body);
                    } catch (e) {
                        return callback(e, null);
                    }
                    
                    if (response.json.ratelimit > 0 ||
                        response.json.errors.length > 0) {
                        return callback(new Error('Rate limited.'), null);
                    }
                    
                    // success
                    return callback(null, true);
                 });
};

const replyMessageUsingTemplate = (template, substitutions, sourceMessageFullId, callback) => {
    if (!messageTemplates[template]) {
        return callback(new Error(`Message template ${template} not found.`));
    }
    
    let messageText = messageTemplates[template];
    for (let variable in substitutions) {
        if (substitutions.hasOwnProperty(variable)) {
            const re = new RegExp(['{', variable, '}'].join(''), 'ig');
            messageText = messageText.replace(re, substitutions[variable]);
        }
    }
    
    // send the message
    const url = `${baseUrl}/api/comment`;
    request.post({
                    url,
                    form: { api_type: 'json', text: messageText, thing_id: sourceMessageFullId },
                    headers: { 'User-Agent': userAgent, 'Authorization': 'Bearer ' + globalAccessToken }
                 }, (err, res, body) => {
                    if (err) {
                        return callback(err, null);
                    }
                    
                    let response;
                    try {
                        response = JSON.parse(body);
                    } catch (e) {
                        return callback(e, null);
                    }
                    
                    if (response.json.ratelimit > 0 ||
                        response.json.errors.length > 0) {
                        return callback(new Error('Rate limited.'), null);
                    }
                    
                    // success
                    return callback(null, true);
                 });
};

const getMessageAuthor = (thingId, accessToken, callback) => {
    const url = util.format('%s/api/info?id=%s', baseUrl, thingId);
    request.get({ url: url, headers: { 'User-Agent': userAgent, 'Authorization': 'Bearer ' + globalAccessToken } }, (err, res, body) => {
        if (err) {
            return callback(err, null);
        }
        
        let response;
        try {
            response = JSON.parse(body);
        } catch (e) {
            return callback(e, null);
        }
        
        return callback(null, (response.data.children.length > 0) ? response.data.children[0].data.author : null);
    });
};

const doSendTip = function(body, message, callback) {
    /**
     * accepted formats:
     * 1 usd u/lbryian OR u/lbryian 1 usd
     * 1 lbc u/lbryian OR u/lbryian 1 lbc
     * $1 u/lbryian OR u/lbryian $1
     */
    const parts = body.split(' ', 3);
    const parentId = message.data.parent_id ? message.data.parent_id.trim() : null;
    if ((!parentId || parentId.length === 0) || (parts.length === 0) || (parts.length !== 3 && (parts.length === 2 && parts[0].substring(0,1) !== '$'))) {
        // ignore the comment
        return callback(null, null);
    }
    
    if (parts[0] && parts[0].substring(0, 1) === '/') {
        parts[0] = parts[0].substring(1);
    }
     
    let amountUsd = 0;
    let amountLbc = 0;
    const nameFirst = parts[0] === config.redditName;
    if (parts.length === 2) {
        // get the amount
        amountUsd = parseFloat(parts[nameFirst ? 1 : 0].substring(1));
        if (isNaN(amountUsd) || amountUsd <= 0) {
            return sendPMUsingTemplate('onsendtip.invalidamount', { how_to_use_url: howToUseUrl }, message.data.author, () => {
                callback(null, null);
            });
        }
    } else if (parts.length === 3) {
        const amount = parseFloat(parts[nameFirst ? 1 : 0]);
        const unit = parts[nameFirst ? 2 : 1].toLowerCase();
        if (isNaN(amount) || amount <= 0 || ['usd', 'lbc'].indexOf(unit) === -1) {
            // invalid amount or unit
            return callback(null, null);
        }
        
        if (unit === 'lbc') {
            amountLbc = amount;
        } else {
            amountUsd = amount;
        }
    }
    
    if (amountLbc > 0 || amountUsd > 0) {
        const parsedAmount = (parts.length === 2) ? parts[nameFirst ? 1 : 0] : [parts[nameFirst ? 1 : 0], parts[nameFirst ? 2 : 1]].join(' ');
        // get the author of the parent message
        async.waterfall([
            (cb) => {
                getMessageAuthor(message.data.parent_id, globalAccessToken, cb);
            },
            (recipient, cb) => {
                const sender = message.data.author;
                if (sender !== recipient) {
                    return cb(null, { amountLbc, amountUsd, message, recipient, sender, parsedAmount });
                }
                
                return cb(null, null);
            },
            (tipdata, cb) => {
                if (tipdata) {
                    if (tipdata.amountUsd > 0) {
                        return convertUsdToLbc(tipdata.amountUsd, (err, convertedAmount) => {
                            if (err) {
                                return cb(err);
                            }
                            
                            tipdata.amountLbc = convertedAmount;
                            return cb(null, tipdata);
                        });
                    } else if (tipdata.amountLbc > 0 && (!tipdata.amountUsd || tipdata.amountUsd === 0)) {
                        return convertLbcToUsd(tipdata.amountLbc, (err, convertedAmount) => {
                            if (err) {
                                return cb(err);
                            }
                            
                            tipdata.amountUsd = convertedAmount;
                            return cb(null, tipdata);
                        });
                    }
                }

                return cb(null, null);    
            },
            (data, cb) => {
                if (data) {
                    return sendTip(data.sender, data.recipient, data.amountLbc, data, cb);
                }
                
                return cb(null, null);
            }
        ], callback);
    }
};

const doSendBalance = (message, callback) => {
    async.waterfall([
        (cb) => {
            createOrGetUserId(message.data.author, cb);
        },
        (authorId, cb) => {
            getBalance(authorId, cb);
        },
        (balance, cb) => {
            // send message with balance
            replyMessageUsingTemplate('onbalance', { how_to_use_url: howToUseUrl, amount: balance }, message.data.name, cb);
        },
        (success, cb) => {
            // mark messge as read
            markMessageRead(message.data.name, cb);
        }
    ], (err) => {
        if (err) {
            console.log(err);
            return callback(err, null);
        }
        
        // success
        return callback(null, true);
    });
};

const sendLbcToAddress = (address, amount, callback) => {
    request.post({ url: config.lbrycrd.rpcurl, json: { method: 'sendtoaddress', params: [address, amount] } }, (err, resp, body) => {
        if (err || body.error) {
            return callback(err || body.error, null);
        }
        
        return callback(null, body.result);
    });  
};

const doWithdrawal = (amount, address, message, callback) => {
    const data = {};
    async.waterfall([
        (cb) => {
            // Start DB transaction
            db.beginTransaction((err) => {
                if (err) {
                    return cb(err, null);
                }
                return cb(null, true);
            });
        },
        // prevent withdrawal to deposit address
        (started, cb) => {
            createOrGetUserId(message.data.author, cb);
        },
        (authorId, cb) => {
            data.userId = authorId;
            getDepositAddress(authorId, cb);
        },
        (depositAddress, cb) => {
            if (address === depositAddress) {
                return cb(new Error('Attempt to withdraw to deposit address.'), null);
            }
            
            return getBalance(data.userId, cb);
        },
        (balance, cb) => {
            // check sufficient balance
            if (balance < amount || balance - amount < 0) {
                return sendPMUsingTemplate('onwithdraw.insufficientfunds', { how_to_use_url: howToUseUrl }, message.data.author, () => {
                    cb(new Error('Insufficient funds'), null);
                });
            }
            
            // Update the balance
            db.query('UPDATE Users SET Balance = Balance - ? WHERE Id = ?', [amount, data.userId], cb);
        },
        (res, fields, cb) => {
            // Send the transaction on the blockchain
            sendLbcToAddress(address, amount, cb);
        },
        (txhash, cb) => {
            data.txhash = txhash;
            // Insert the withdrawal entry
            db.query('INSERT INTO Withdrawals (UserId, TxHash, Amount, Created) VALUES (?, ?, ?, UTC_TIMESTAMP())', [data.userId, txhash, amount], cb);
        },
        (res, fields, cb) => {
            // commit the transaction
            db.commit((err) => {
                if (err) {
                    return cb(err, null);
                }
                
                return cb(null, true);
            });
        },
        (success, cb) => {
            // mark messge as read
            markMessageRead(message.data.name, cb);
        },
        (success, cb) => {
            // send a reply
            replyMessageUsingTemplate('onwithdraw', { how_to_use_url: howToUseUrl, address: address, amount: amount, txid: data.txhash }, message.data.name, cb);
        }
    ], (err) => {
        if (err) {
            console.log(err);
            return db.rollback(() => {
                callback(err, null);
            });
        }
        
        // success
        return callback(null, true);
    });
};

const doSendDepositAddress = (message, callback) => {
    async.waterfall([
        (cb) => {
            createOrGetUserId(message.data.author, cb);
        },
        (authorId, cb) => {
            getDepositAddress(authorId, cb);
        },
        (address, cb) => {
            // send message with balance
            replyMessageUsingTemplate('ondeposit', { how_to_use_url: howToUseUrl, address: address }, message.data.name, cb);
        },
        (success, cb) => {
            // mark messge as read
            markMessageRead(message.data.name, cb);
        }
    ], (err) => {
        if (err) {
            return callback(err, null);
        }
        
        // success
        return callback(null, true);
    });
};

// Commands
// balance (PM)
// deposit (PM)
// tip (Comment): <amount> <unit> u/lbryian
// withdraw (PM): withdraw <amount> <address>
const processMessage = function(message, callback) {
    if (!message.kind || !message.data) {
        return callback(new Error('Invalid message specified for processing.'));
    }
    
    const body = String(message.data.body).trim();
    if (message.kind === privateMessageKind) {
        // balance, deposit or withdraw
        // Check the command
        if ('balance' === body.toLowerCase()) {
            // do balance check
            return doSendBalance(message, callback);
        } else if ('deposit' === body.toLowerCase()) {
            // send deposit address
            return doSendDepositAddress(message, callback);
        } else {
            // withdrawal
            const parts = body.split(' ');
            if (parts.length !== 3 ||
                parts[0].toLowerCase() !== 'withdraw') {
                // invalid message, ignore
                return callback(null, null);
            }
            
            const amount = parseFloat(parts[1]);
            if (isNaN(amount) || amount < 0) {
                // TODO: send a message that the withdrawal amount is invalid
                return sendPMUsingTemplate('onwithdraw.invalidamount', { how_to_use_url: howToUseUrl }, message.data.author, () => {
                    callback(null, null);
                });
            }
            
            if (amount <= config.lbrycrd.txfee) {
                return sendPMUsingTemplate('onwithdraw.amountltefee', { how_to_use_url: howToUseUrl, amount: amount, fee: config.lbrycrd.txfee }, message.data.author, () => {
                    callback(null, null);
                });
            }
            
            // base58 check the address
            const address = parts[2];
            try {
                base58.decode(address);
            } catch(e) {
                return sendPMUsingTemplate('onwithdraw.invalidaddress', { how_to_use_url: howToUseUrl }, message.data.author, () => {
                    callback(null, null);
                });
            }
            
            return doWithdrawal(amount, address, message, callback);
        }
        
        return callback(null, null);
    }
    
    if (message.kind === commentKind) {
        doSendTip(body, message, callback);
    }
};

// Run the bot
const runBot = () => {
    async.waterfall([
        (cb) => {
            if (!accessTokenTime || moment.duration(moment().diff(accessTokenTime)).asMinutes() >= 55) {
                // remove old or expired tokens
                // TODO: Implement refreshToken
                if (fs.existsSync(config.accessTokenPath)) {
                    fs.unlinkSync(config.accessTokenPath);
                }
            }
            
            return cb(null);
        },
        (cb) => {
            loadAccessToken(cb);  
        },
        (token, cb) => {
            if (!token || token.trim().length === 0) {
                return oauth(cb);
            }
            
            return cb(null, token);
        },
        (token, cb) => {
            globalAccessToken = token;
            retrieveUnreadMessages(token, cb);
        },
        (unread, cb) => {
            async.eachSeries(unread, (message, ecb) => {
                processMessage(message, ecb);    
            }, cb);
        }
    ], (err) => {
        if (err) {
            console.log(err);
        }
        
        // Wait 1 minute for next iteration
        console.log('Waiting 1 minute...');
        setTimeout(runBot, 60000);
    });    
};
runBot();