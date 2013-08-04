var vcompare = require('../lib/vcompare'),
    async = require('async'),
    winston = require('winston'),
    mime = require('mime'),
    config = require('../config_' + (process.env.NODE_ENV || 'dev'));

module.exports.listen = function(io, socket, rooms){
  //host --> server --> host (host sends metadata and a request to create a new room, Host in return gets a request to get fresh file data)
  socket.on('createRoom', function (data) {
    var hostVersion = (data.hostVersion)?data.hostVersion:"0.1.0";
    if(vcompare.compare(hostVersion, config.minHostVersion) >= 0){
      socket.set('room', data.name);
      socket.set('userId', 'host');
      socket.set('role', 'host');
      socket.join(data.name);

      rooms[data.name] = data;
      rooms[data.name].files = [];
      rooms[data.name].currentFile = "no file";
      rooms[data.name].body = "";
      rooms[data.name].hostSocket = socket;
      rooms[data.name].moderatorPass = data.moderatorPass;
      rooms[data.name].authMap = {
        moderator:{'editData':true, 'newChatMessage':true, 'changeUserId':true, 'saveCurrentFile': true, 'changeCurrentFile':true, 'changeRole':true},
        editor:{'editData':true, 'newChatMessage':true, 'changeUserId':true, 'saveCurrentFile': true, 'changeCurrentFile':true, 'changeRole':false},
        default:{'editData':false, 'newChatMessage':true, 'changeUserId':true, 'saveCurrentFile': false, 'changeCurrentFile':false, 'changeRole':false}
      }

      //reset the other participants (if any) 
      socket.broadcast.to(data.name).emit('newUser', {userId:'host', isYou:false});
      socket.broadcast.to(data.name).emit('newChatMessage', 'host has re-entered the room', 'hackify');
      socket.broadcast.to(data.name).emit('resetHostData');
      rooms[data.name].files.forEach(function(file){
        socket.broadcast.to(data.name).emit('fileAdded', file)
      });
      socket.broadcast.to(data.name).emit('roomReadOnly', rooms[data.name].readOnly);  
      winston.info('room created', { name:data.name, hostVersion: data.hostVersion, hostAddr: socket.handshake.address });
    }else{
      winston.info('refusing room create (version check failed)', {hostVersion:hostVersion, minHostVersion: config.minHostVersion});
      socket.emit('error', 'cannot join room, minimum host version is ' + config.minHostVersion + ' your hackify version is ' + hostVersion + '. please update your hackify module (npm install -g hackify)')
    }
  });

  //client --> server --> client (client joins a particular room and gets room data refreshed)
  socket.on('joinRoom', function (data) {
    if(rooms[data.room]){
      //set up the socket properties
      socket.join(data.room);
      socket.set('room', data.room);

      var userInfo = (socket.handshake.session.passport.user)?socket.handshake.session.passport.user:{};
      socket.set('userInfo', userInfo);

      var userId = (userInfo.displayName)?userInfo.displayName:'hckr' + Math.floor(Math.random() * 9999).toString();
      socket.set('userId', userId);

      socket.set('role', 'default');

      //tell the socket about the room state
      var roomState = rooms[data.room];
      roomState.files.forEach(function(file){
        socket.emit('fileAdded', file)
      });
      socket.emit('changeCurrentFile', roomState.currentFile, mime.lookup(roomState.currentFile));
      socket.emit('refreshData', roomState.body);
      socket.emit('roomReadOnly', roomState.readOnly);
      socket.emit('roomAuthMap', roomState.authMap);

      //tell this socket about all of the users (including itself)
      var clients = io.sockets.clients(data.room);
      clients.forEach(function(client){
        async.parallel([
          function(callback){ client.get('userId', function(err, val){ callback(err, val); }); },
          function(callback){ client.get('userInfo', function(err, val){ callback(err, val); }); },
          function(callback){ client.get('role', function(err, val){ callback(err, val); }); },
          function(callback){ client.get('requestedRole', function(err, val){ callback(err, val); }); }
        ],
        function(err, results){
          if(!err){
            var clientUserId = results[0], clientUserInfo = results[1], clientRole = results[2], clientRequestedRole = results[3];

            if(clientUserId){
              socket.emit('newUser', {
                userId:clientUserId, 
                isYou:(client===socket)?true:false,
                userInfo: clientUserInfo,
                role: clientRole,
                requestedRole: clientRequestedRole
              });
            }
          } else {
            winston.error('problem determining socket info', {err:err});
          }
        });
      });        

      //now tell all of the other sockets about the new user
      socket.broadcast.to(data.room).emit('newUser', {userId:userId, isYou:false, userInfo:userInfo, role:'default'});
      winston.info('user joined room', {userId: userId, room:data.room, clientAddr: socket.handshake.address});
    }else{
      socket.emit('newChatMessage','room ' + data.room + ' does not exist', 'hackify')
    }
  });

  socket.on('disconnect', function(){
    socket.get('room', function (err, room) {
      if(!err && room!="" && room !=null){
        socket.get('userId', function(err, userId){
          socket.leave(room);
          socket.set('room', null);
          io.sockets.in(room).emit('exitingUser',userId);
          io.sockets.in(room).emit('newChatMessage', userId + ' has left the room', 'hackify');

          //handle host socket disconnection
          if(socket===rooms[room].hostSocket){
            rooms[room].readOnly = true;
            rooms[room].hostSocket = null;
            socket.broadcast.to(room).emit('roomReadOnly', true);
            io.sockets.in(room).emit('newChatMessage', 'room is now read only', 'hackify');
          }

          winston.info('user left room', {userId: userId, room:room, clientAddr: socket.handshake.address});

          //check if room is empty
          if(io.sockets.clients(room).length===0 && !rooms[room].permanent){
            delete rooms[room];
            winston.info('room closed', {room:room});
          }
        })
      }
    });
  });
};
