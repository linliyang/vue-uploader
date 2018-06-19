# uploader


## install

``` 
    $ npm install git@github.com:linliyang/vue-uploader.git --save
```

## usage

```
new Uploader({
    server : '',
    extensions : ['gif', 'jpg', 'jpeg', 'png'],
    onError(code, message){
       //todo
    },
    onDone(response){
        //todo
    },
    onProgress(percent){
        //todo
    },
    builtInFormDataNames : {
        data : 'upload'
    },
    maxThreads : 1,
    imageAutoCompress : true,
    compress : {
        width: 1000
    }
})
```
