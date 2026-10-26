const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

https.request = (_target, _options, callback) => {
  let requestBody = '';
  const request = new EventEmitter();
  request.write = (chunk) => { requestBody += String(chunk); };
  request.setTimeout = (_milliseconds, onTimeout) => {
    request.mockTimeout = onTimeout;
  };
  request.destroy = (error) => {
    process.nextTick(() => request.emit('error', error));
  };
  request.end = () => {
    const payload = JSON.parse(requestBody);
    const user = JSON.parse(payload.messages[1].content);
    const marker = user.creativeDirection?.note || user.note || '';
    if (marker === '__mock_timeout__') {
      request.mockTimeout();
      return;
    }
    const content = marker === '__mock_invalid_json__'
      ? '{invalid'
      : marker === '__mock_empty__'
        ? ''
        : JSON.stringify({
          reply: '已整理商品资料。',
          followUpQuestion: user.task === 'follow_up' ? '希望使用什么背景？' : '',
          descriptionA: marker === '__mock_schema_invalid__' ? '' : '商品主体清晰呈现于自然窗边，使用柔和光线和简洁构图。',
          descriptionAStructured: {
            scene: '自然窗边',
            composition: '主体居中',
            lightingMood: '柔和自然光',
            mustKeep: ['商品主体'],
            forbidden: ['文字和水印']
          }
        });
    const response = Readable.from([JSON.stringify({ choices: [{ message: { content } }] })]);
    response.statusCode = 200;
    response.setEncoding('utf8');
    callback(response);
  };
  return request;
};
