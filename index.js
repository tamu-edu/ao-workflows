const axios = require('axios');

axios.get('https://aap.ao.tamu.edu/')
  .then(function (response) {
    console.log(response);
  })
  .catch(function (error) {
    console.log(error);
  });