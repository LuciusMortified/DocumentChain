'use strict';
var debug = require('debug');
var CryptoJS = require('crypto-js');
var express = require('express');
var bodyParser = require('body-parser');
var WebSocket = require('ws');
var fs = require('fs');
var scanner = require('scan-neighbors');
var config = require('./config');

var sockets = [];
const MessageType = {
    QUERY_LATEST: 0, //
    QUERY_ALL: 1, //
    RESPONSE_BLOCKCHAIN: 2 //
};
const DataType = {
    KEY : 0,
    DOCUMENT : 1
};
const MenuTab = {
    DASHBOARD : 'dashboard',
    DOCUMENTS : 'documents',
    SETTINGS : 'settings',
    PROFILE : 'profile'
};

var menu_tab = MenuTab.DASHBOARD;
var LOGIN, PASSWORD, LOCALSTORAGE;

class Block {
    constructor(index, previousHash, timestamp, data, hash) {
        this.index = index;
        this.previousHash = previousHash;
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash;
    }
}

var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "genesis block", "86747cd5d17d3aef4bf7c7bad8c022ae9fafa9346cc4be2663be11764a01bd96");
};

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    /*app.post('/addBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });*/
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress.replace(/^.*:/, '') + ':' + s._socket.remotePort));
    });
    /*
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });*/
    app.listen(config.http_port, () => console.log('Listening http on port: ' + config.http_port));
};


var initP2PServer = () => {
    var server = new WebSocket.Server({port: config.p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('Listening websocket p2p port on: ' + config.p2p_port);
};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};

var generateNextBlock = (blockData) => {
    let previousBlock = getLatestBlock();
    let nextIndex = previousBlock.index + 1;
    let nextTimestamp = new Date().getTime() / 1000;
    let nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
};

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

var calculateHash = (index, previousHash, timestamp, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers, callback) => {
    newPeers.forEach((peer, index) => {
        let ws = new WebSocket(peer);
        ws.on('open', () => {
            console.log(peer+' connected!');
            initConnection(ws);
        });
        ws.on('error', () => {
            console.log(peer+' connection failed!');
        });
        const done = index >= newPeers.length - 1;
        if(done)
            callback();
    });
    if(newPeers.length===0)
        callback();
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
};

var replaceChain = (newBlocks, callback) => {
    if(isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
    if(callback)
        callback();
};

var isValidChain = (blockchainToValidate) => {
    if(JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for(var i=1;i<blockchainToValidate.length;i++) {
        if(isValidNewBlock(blockchainToValidate[i], tempBlocks[i-1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => clearBlockchain(blockchain)[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type':MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type':MessageType.QUERY_ALL});

var responseChainMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify(clearBlockchain(blockchain))
});

var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

var clearBlockchain = (blockchain) => {
    let clear_blockchain = [];
    for(let i=0;i<blockchain.length;i++) {
        let block = blockchain[i];
        if(block.visited)
            delete block.visited;
        clear_blockchain.push(block);
    }
    return clear_blockchain;
};

var loadPeers = () => {
    let oldPeers = [];
    fs.readFile(config.peersFile, (err, data) => {
        if(err)
            console.error(err);
        try {
            oldPeers = JSON.parse(data.toString());
        } catch (e) {
            console.error(e);
            oldPeers = [];
        }
        scanner.scanNodes(config.p2p_port, function (err, nodes) {
            if(err) console.error(err);

            if(nodes)
                for(let i=0;i<nodes.length;i++) {
                    console.log('New device: '+nodes[i]);
                    const peer = 'ws://'+nodes[i]+':'+config.p2p_port;

                    if(oldPeers.indexOf(peer)<0)
                        oldPeers.push(peer);
                }
            fs.writeFile(config.peersFile, JSON.stringify(oldPeers));
            connectToPeers(oldPeers, () => {
                setTimeout(() => {
                    $('.loading').addClass('d-none');
                    $('.form-signin').removeClass('d-none');
                }, 500);
            });
        });
    });
};

let loadLocalBlockchain = (callback) => {
    fs.readFile(config.blockchainFile, (err, data) => {
        if(err) {
            callback();
            return console.error(err);
        }
        try {
            let new_blockchain = JSON.parse(data);
            if(Array.isArray(new_blockchain))
                replaceChain(new_blockchain, callback);
        } catch (e) {
            console.error(e);
            callback();
        }
    });
};

loadLocalBlockchain(() => {
    initHttpServer();
    initP2PServer();
    loadPeers();
});

/*function encrypt(text, password) {
    let cipher = crypto.createCipher(algorithm, password);
    let crypted = cipher.update(text, 'utf8', 'hex');
    crypted += cipher.final('hex');
    return crypted;
}

function decrypt(text, password) {
    let decipher = crypto.createDecipher(algorithm, password);
    let dec = decipher.update(text,'hex','utf8');
    dec += decipher.final('utf8');
    return dec;
}*/
let gui = require('nw.gui');
let win = gui.Window.get();

win.on('loaded', () => {
    $('.form-signin').submit(function () {
        event.preventDefault();
        var loginVal = $('#inputLogin').val();
        var passVal = $('#inputPassword').val();
        fs.readFile(loginVal+'.dat', (err, data) => {
            if(err) {
                $('.form-signin-error').text('Account does not exist!');
                return console.error(err);
            }
            var decryptedBytes = CryptoJS.AES.decrypt(data.toString(), passVal);
            try {
                var localAccountData = JSON.parse(decryptedBytes.toString(CryptoJS.enc.Utf8));
                if (localAccountData.login) {
                    if (localAccountData.login === loginVal) {
                        LOGIN = loginVal;
                        PASSWORD = passVal;
                        LOCALSTORAGE = localAccountData;
                        $('.form-signin').addClass('d-none');

                        loadSettings();
                        loadMain();
                    } else {
                        $('.form-signin-error').text('Invalid login or password!');
                    }
                } else {
                    $('.form-signin-error').text('Invalid login or password!');
                }
            } catch (err) {
                console.error(err);
                $('.form-signin-error').text('Invalid login or password!');
            }
        });
    });

    $('#registerButton').click(function () {
        $('.form-signin').addClass('d-none');
        $('.form-signup').removeClass('d-none');
    });

    $('.form-signup').submit(function () {
        event.preventDefault();
        var passVal = $('#inputPasswordReg').val(),
            rePassVal = $('#inputRePasswordReg').val();
        let loginVal = $('#inputLoginReg').val();
        if(passVal === rePassVal) {
            LOGIN = loginVal;
            PASSWORD = passVal;
            LOCALSTORAGE = {
                login: loginVal,
                keys: []
            };
            let data = CryptoJS.AES.encrypt(JSON.stringify(LOCALSTORAGE), passVal);
            fs.writeFile(loginVal+'.dat', data,(err) => {
                if(err) {
                    $('.form-signup-error').text(err.message);
                    return console.error(err);
                }
                $('.form-signup').addClass('d-none');
                loadSettings();
                loadMain();
            });
        } else {
            $('.form-signup-error').text('Passwords do not match!');
        }
    });

    $('#registerBackButton').click(function () {
        $('.form-signup').addClass('d-none');
        $('.form-signin').removeClass('d-none');
    });

    $('.nav-item').click(function () {
        $('.nav-item').removeClass('active');
        $(this).addClass('active');
        var new_tab = $(this).attr('menu');
        for(var tab in MenuTab) {
            if(MenuTab.hasOwnProperty(tab) && MenuTab[tab] === new_tab) {
                menu_tab = new_tab;
                loadMain();
                return;
            }
        }
    });

    $('.navbar-brand').click(function () {
        $('.nav-item').removeClass('active');
        menu_tab = MenuTab.DASHBOARD;
        loadMain();
    });

    $('.logout').click(function () {
        $('#main').addClass('d-none');
        $('.form-signin').removeClass('d-none');
    });

    $('.documents .is-visited').click(function () {
        $(this).toggleClass('active');
        loadDocuments();
    });

    $('#modalDocumentAdd .btn-primary').click(function () {
        let blockData;
        let filepath = $('#modalDocumentAdd input[type="file"]').val();
        if(filepath === '') {
            $('#modalDocumentAdd .modal-error').text('Choose file!');
            return;
        }
        if(sockets.length===0) {
            $('#modalDocumentAdd .modal-error').text('No one peer in network! Try later.');
            return;
        }
        let filename = filepath.replace(/^.*[\\\/]/, '');
        fs.readFile(filepath, (err, data) => {
            if(err) {
                $('#modalDocumentAdd .modal-error').text(err.name);
                return console.error(err);
            }
            blockData = {
                type: DataType.DOCUMENT,
                filename: filename,
                file: data.toString('base64'),
                description: $('#modalDocumentAdd textarea[name="description"]').val()
            };
            let encrypt_level = parseInt($('#modalDocumentAdd .dropdown-item.active').attr('level'));
            if(encrypt_level>=0) {
                //Encrypt file
                let enc_key = LOCALSTORAGE.keys[encrypt_level].key;
                blockData.encrypted = CryptoJS.AES.encrypt('encrypted', enc_key).toString();
                blockData.file = CryptoJS.AES.encrypt(blockData.file, enc_key).toString();
            }
            let newBlock = generateNextBlock(blockData);
            addBlock(newBlock);
            broadcast(responseLatestMsg());
            console.log('Added new block '+newBlock.hash);
            $('#modalDocumentAdd').modal('hide');
            loadDocuments();
        });
    });

    $('#modalPeerAdd .btn-primary').click(() => {
        let peer = $('#modalPeerAdd input').val();
        if(peer !== '')
        connectToPeers([peer], () => {
            fs.readFile(config.peersFile, (err, data) => {
                if(err)
                    return console.error(err);
                try {
                    let peers = JSON.parse(data.toString());
                    if(Array.isArray(peers) && peers.indexOf(peer)<0) {
                        peers.push(peer);
                        fs.writeFile(config.peersFile, JSON.stringify(peers));
                    }
                } catch (e) {
                    console.error(e);
                }
                $('#modalPeerAdd').modal('hide');
            });
        });
    });

    $('#modalKeyAdd .btn-primary').click(() => {
        let key_name = $('#modalKeyAdd input[name="name"]').val();
        let key = $('#modalKeyAdd input[name="key"]').val();
        if(key_name === '' || key === '')
            return;
        let obj_key = {
            name: key_name,
            key: key
        };
        if(LOCALSTORAGE.keys.indexOf(obj_key)<0) {
            LOCALSTORAGE.keys.push(obj_key);
        }
        $('#modalKeyAdd').modal('hide');
        loadSettings();
    });

    $('.profile .change-password').submit(function () {
        event.preventDefault();
        let cur_pass_val = $(this).find('input[name="current"]').val();
        let new_pass_val = $(this).find('input[name="new"]').val();
        let re_new_pass_val = $(this).find('input[name="renew"]').val();
        if(cur_pass_val === PASSWORD && new_pass_val === re_new_pass_val) {
            PASSWORD = new_pass_val;
            let data = CryptoJS.AES.encrypt(JSON.stringify(LOCALSTORAGE), PASSWORD);
            fs.writeFile(LOGIN+'.dat', data,(err) => {
                if(err)
                    return console.error(err);
            });
        }
    });

    $('.profile .delete-account').click(function () {
        fs.unlink(LOGIN+'.dat', function (err) {
            if(err)
                return console.error(err);
            $('#main').addClass('d-none');
            $('.form-signin').removeClass('d-none');
        });
    });

    setInterval(function () {
        loadDashboard();
    }, 1000);

});

function loadDocuments() {
    let tbody = $('.documents tbody');

    tbody.empty();
    for(let block in blockchain) {
        if(blockchain.hasOwnProperty(block)) {
            if(!blockchain[block].data.filename)
                continue;
            if(blockchain[block].visited && !$('.documents .is-visited').hasClass('active'))
                continue;
            let obj_key;
            if(blockchain[block].data.encrypted) {
                let keys = LOCALSTORAGE.keys;
                let canDecrypt = false;
                for(let i=0;i<keys.length;i++) {
                    let check = CryptoJS.AES.decrypt(blockchain[block].data.encrypted, keys[i].key).toString(CryptoJS.enc.Utf8);
                    if(check === 'encrypted') {
                        canDecrypt = true;
                        obj_key = keys[i];
                        break;
                    }
                }
                if(!canDecrypt)
                    continue;
            }

            let tr = document.createElement('tr');

            let tdIndex = document.createElement('td');
            tdIndex.innerText = blockchain[block].index;
            tr.appendChild(tdIndex);

            let tdLevel = document.createElement('td');
            tdLevel.innerText = (blockchain[block].data.encrypted?obj_key.name:'All');
            tr.appendChild(tdLevel);

            let tdName = document.createElement('td');
            tdName.innerText = blockchain[block].data.filename;
            tr.appendChild(tdName);

            let tdActions = document.createElement('td');
            $(tdActions).css('float','right');

            $(tdActions).append(
                '<button class="btn btn-sm btn-dark mr-1 mb-1" onclick="saveFile('+block+')"><i class="material-icons">&#xE2C4;</i></input>'
            );

            let description = blockchain[block].data.description || 'None.';
            let desc_popover = $('<button class="btn btn-sm btn-dark mr-1 mb-1" data-placement="left" data-toggle="popover" title="File description" data-content=\"'+description+'\"><i class="material-icons">&#xE873;</i></button>');
            desc_popover.popover();
            $(tdActions).append( desc_popover );

            let visited_btn = $('<button class="btn btn-sm btn-dark mb-1 visit-doc'+block+'"><i class="material-icons">'+(blockchain[block].visited?'&#xE8F5':'&#xE8F4')+'</i></button>');
            visited_btn.click(function () {
                blockchain[block].visited = !blockchain[block].visited;
                let icon = blockchain[block].visited?'&#xE8F5':'&#xE8F4';
                $(this).find('i').html(icon);
                loadDocuments();
            });
            $(tdActions).append(visited_btn);

            tr.appendChild(tdActions);
            tbody.append(tr);
        }
    }
}

function loadDashboard() {
    let spanPeersCount = $('#peersCount');
    if(parseInt(spanPeersCount.text())!==sockets.length)
        spanPeersCount.text(sockets.length);

    let spanDocsCount = $('#docsCount');
    if(parseInt(spanDocsCount.text())!==blockchain.length-1)
        spanDocsCount.text((blockchain.length-1));
}

function loadSettings() {
    let keys_list = $('.keys-list');
    keys_list.empty();

    let dd_menu = $('#modalDocumentAdd .dropdown-menu');
    dd_menu.empty();
    dd_menu.append('<h6 class="dropdown-header">Encryption ~v</h6>\n');
    dd_menu.append('<a href="#" class="dropdown-item active" level=-1>None</a>');
    if(LOCALSTORAGE.keys) {
        for (let i = 0; i < LOCALSTORAGE.keys.length; i++) {
            dd_menu.append('<a href="#" class="dropdown-item" level=' + i + '>' + LOCALSTORAGE.keys[i].name + '</a>');

            let li = document.createElement('li');
            li.className += 'list-group-item';

            let pli = document.createElement('p');
            pli.innerText = LOCALSTORAGE.keys[i].name;
            pli.className += 'd-inline-block';
            li.appendChild(pli);

            let buttonli = $('<button class="btn btn-primary btn-sm float-right d-inline-block">Remove</button>');
            buttonli.click(function () {
                LOCALSTORAGE.keys.splice(i, 1);
                loadSettings();
            });
            $(li).append(buttonli);
            keys_list.append(li);
        }
    }

    $('.dropdown-item').click(function () {
        $('.dropdown-item').removeClass('active');
        $(this).addClass('active');
    });
}

function loadMain() {
    $('.login').text('Hi, '+LOCALSTORAGE.login+'!');
    $('#main').removeClass('d-none');
    $('#main .menu-tab').addClass('d-none');
    $('#main .'+menu_tab).removeClass('d-none');
    switch (menu_tab) {
        case MenuTab.DASHBOARD:
            loadDashboard();
            break;
        case MenuTab.DOCUMENTS:
            loadDocuments();
            break;
        case MenuTab.SETTINGS:
            loadSettings();
            break;
    }
}

function saveFile(block) {
    let chooser = $('#savefile');
    chooser.attr('nwsaveas',blockchain[block].data.filename);
    chooser.unbind('change');
    chooser.change(function () {
        let file = blockchain[block].data.file;
        if(blockchain[block].data.encrypted) {
            let keys = LOCALSTORAGE.keys;
            let obj_key;
            for(let i=0;i<keys.length;i++) {
                let check = CryptoJS.AES.decrypt(blockchain[block].data.encrypted, keys[i].key).toString(CryptoJS.enc.Utf8);
                if(check === 'encrypted') {
                    obj_key = keys[i];
                    break;
                }
            }
            if(obj_key === undefined) {
                console.error('I cant decrypt this file '+blockchain[block].data.filename);
                return;
            }
            file = CryptoJS.AES.decrypt(file, obj_key.key).toString(CryptoJS.enc.Utf8);
        }
        fs.writeFile($(this).val(), new Buffer(file, 'base64'), function (err) {
            if(err)
                return console.error(err);
        });
    });
    chooser.trigger('click');
}

win.on('closed', () => {
    fs.writeFile(config.blockchainFile, JSON.stringify(blockchain));
    if(!LOGIN || !LOCALSTORAGE || !PASSWORD)
        return;
    let data = CryptoJS.AES.encrypt(JSON.stringify(LOCALSTORAGE), PASSWORD);
    fs.writeFile(LOGIN+'.dat', data,(err) => {
        if(err) return console.error(err);
    });
});