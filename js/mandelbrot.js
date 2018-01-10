(function () {
"use strict";

var HP_CUTOFF_EXP = 16;
var HP_CUTOFF = new BigDecimal("1e-16");
var TEN = new BigDecimal("10");
var TWO = new BigDecimal("2");


var OSC;  // Off-screen canvas, holds the the Mandelbrot set.
var OSG;  // Graphics context for on-screen canvas.
var canvas;    // On-screen canvas -- shows OSC, with stuff possibly drawn on top.
var graphics;  // Graphics context for on-screen canvas.

var autoResizeCanvas = false;
var resizeTimeout;

var ArrayType = window.Uint32Array || Array;

var workers;
var wokerCount = 1;
var jobNum = 0;

var running = false;
var repaintTimeout;

var /* BigDecimal */ xmin_requested, ymin_requested, xmax_requested, ymax_requested;
var /* BigDecimal */ xmin, ymin, xmax, ymax;
var /* BigDecimal */ dx, dy;
var /* Uint32Array */ xminArray, yvalArray, dxArray;

var jobs;
var jobsCompleted;
var workerCount = 1;
var jobStartTime, timePerJob;
var highPrecision;

var COMPUTING_FIRST_PASS = 1, DONE_FIRST_PASS = 2, COMPUTING_SECOND_PASS = 3, IDLE = 4;
var state = IDLE;

var dragbox = null;

var maxIterations;
var palette;
var stretchPalette = true;
var fixedPaletteLength = 250;
var paletteLength, paletteOffsetFraction;
var paletteColors;

var savedIterationCounts;
var savedIterationCounts2ndPass;

var imageData, hres, vres;  // for setting pixel colors.

var currentXML = null;

var undoList = null; // will be an array; null here prevents SetDefaults from adding a spurious undo item
var undoCount = 0;
var applyUndoInProgress = false;

var interlaced = true;
var interlaceOrder = (function() {
      var order = [127];
      for (var i = 64; i >= 1; i /= 2) {
          var ct = order.length;
          for (var j = 0; j < ct; j++) {
              order.push(order[j] - i);
          }
      }
      return order;
   })();

var digits, chunks;
var /* BigDecimal */ twoTo16 = new BigDecimal("65536");
var log2of10 = Math.log(10)/Math.log(2);


function convert( /* int[] */ x, /* BigDecimal */ X, /* int */ count) {
    var neg = false;
    if (X.signum() == -1) {
        neg = true;
        X = X.negate();
    }
    x[0] = Number(X.setScale(0,BigDecimal.ROUND_DOWN).toString());
    for (var i = 1; i < count; i++) {
        X = X.subtract(new BigDecimal(""+x[i-1]));
        X = X.multiply(twoTo16);
        x[i] = Number(X.setScale(0,BigDecimal.ROUND_DOWN).toString());
    }
    if (neg) {
        negate(x,count);
    }
    function negate( /* int[] */ x, /* int */ chunks) {
        for (var i = 0; i < chunks; i++)
            x[i] = 0xFFFF-x[i];
        ++x[chunks-1];
        for (var i = chunks-1; i > 0 && (x[i] & 0x10000) != 0; i--) {
            x[i] &= 0xFFFF;
            ++x[i-1];
        }
        x[0] &= 0xFFFF;
    }
}



function setLimits(x1, x2, y1, y2, recordUndo) {
    var oldLimits = [xmin_requested,xmax_requested,ymin_requested,ymax_requested];
    xmin_requested = x1;
    xmax_requested = x2;
    ymin_requested = y1;
    ymax_requested = y2;
    if (xmax_requested.compareTo(xmin_requested) < 0) {
       var temp = xmin_requested;
       xmin_requested = xmax_requested;
       xmax_requested = temp;
    }
    if (ymax_requested.compareTo(ymin_requested) < 0) {
       var temp = ymax_requested;
       ymax_requested = ymin_requested;
       ymin_requested = temp;
    }
    checkAspect();
    if (recordUndo) {
        addUndoItem("Change Limits", oldLimits, [xmin_requested,xmax_requested,ymin_requested,ymax_requested]);
    }
}

function checkAspect() {  // adjust requested x/y limits to match aspect ration of image
    xmin = xmin_requested;
    xmax = xmax_requested;
    ymin = ymin_requested;
    ymax = ymax_requested;
    if (xmin.scale() < HP_CUTOFF_EXP + 8)
        xmin.setScale(HP_CUTOFF_EXP + 8);
    if (xmax.scale() < HP_CUTOFF_EXP + 8)
        xmax.setScale(HP_CUTOFF_EXP + 8);
    if (ymin.scale() < HP_CUTOFF_EXP + 8)
        ymin.setScale(HP_CUTOFF_EXP + 8);
    if (ymax.scale() < HP_CUTOFF_EXP + 8)
        ymax.setScale(HP_CUTOFF_EXP + 8);
    var dx = xmax.subtract(xmin).setScale(Math.max(xmax.scale(),HP_CUTOFF_EXP)*2, BigDecimal.ROUND_HALF_EVEN);
    dx = dx.divide(new BigDecimal("" + canvas.width),BigDecimal.ROUND_HALF_EVEN);
    var precision = 0;
    while (dx.compareTo(TWO) < 0) {
       precision++;
       dx = dx.multiply(TEN);
    }
    if (precision < HP_CUTOFF_EXP)
        precision = HP_CUTOFF_EXP;
    var scale = precision + 5 + Math.floor((precision-10)/10);
    xmin = xmin.setScale(scale,BigDecimal.ROUND_HALF_EVEN);
    xmax = xmax.setScale(scale,BigDecimal.ROUND_HALF_EVEN);
    ymin = ymin.setScale(scale,BigDecimal.ROUND_HALF_EVEN);
    ymax = ymax.setScale(scale,BigDecimal.ROUND_HALF_EVEN);

    var width = xmax.subtract(xmin);
    var height = ymax.subtract(ymin);
    var aspect = width.divide(height,BigDecimal.ROUND_HALF_EVEN);
    var windowAspect = new BigDecimal( "" + canvas.width/canvas.height );
    if (aspect.compareTo(windowAspect) < 0) {
        var newWidth = width.multiply(windowAspect).divide(aspect,BigDecimal.ROUND_HALF_EVEN);
        var center = xmax.add(xmin).divide(TWO,BigDecimal.ROUND_HALF_EVEN);
        xmax = center.add(newWidth.divide(TWO,BigDecimal.ROUND_HALF_EVEN)).setScale(scale, BigDecimal.ROUND_HALF_EVEN);
        xmin = center.subtract(newWidth.divide(TWO,BigDecimal.ROUND_HALF_EVEN)).setScale(scale,BigDecimal.ROUND_HALF_EVEN);
    }
    else if (aspect.compareTo(windowAspect) > 0) {
        var newHeight = height.multiply(aspect).divide(windowAspect,BigDecimal.ROUND_HALF_EVEN);
        var center = ymax.add(ymin).divide(TWO,BigDecimal.ROUND_HALF_EVEN);
        ymax = center.add(newHeight.divide(TWO,BigDecimal.ROUND_HALF_EVEN)).setScale(scale,BigDecimal.ROUND_HALF_EVEN);
        ymin = center.subtract(newHeight.divide(TWO,BigDecimal.ROUND_HALF_EVEN)).setScale(scale,BigDecimal.ROUND_HALF_EVEN);
    }
}


function doDraw() {
    graphics.drawImage(OSC,0,0);
    if (dragbox && dragbox.width > 2 && dragbox.height > 2) {
       dragbox.draw();
    }
}

function repaint() {
    doDraw();
    if (running) {
       repaintTimeout = setTimeout(repaint, 500);
       var pass = state == COMPUTING_SECOND_PASS ? " 2nd pass" : "";
       var prec = highPrecision? "high precision, " + digits + " digits" : "normal precision";
       document.getElementById("status").innerHTML =
                "Computing" + pass + ", " + prec + "...  Completed " + jobsCompleted + " of " + canvas.height + " rows";
    }
    else {
        document.getElementById("status").innerHTML = "";
    }
}

function newWorkers(count) {
    var i;
    if (workers) {
       for (i = 0; i < workers.length; i++) {
          workers[i].terminate();
       }
    }
    workers = [];
    for (i = 0; i < count; i++) {
       workers[i] = new Worker("js/mandelbrot-worker.js");
       workers[i].onmessage = jobFinished;
    }
}

function stopJob() {
    if (running) {
       jobNum++;
       running = false;
       document.getElementById("stop").disabled = true;
       if (repaintTimeout)
          clearTimeout(repaintTimeout);
       repaintTimeout = null;
       repaint();
       if (timePerJob < 0 || timePerJob > 150) {
           //console.log("Making new workers");
           newWorkers(workerCount);
       }
    }
}

function startJob() {
    if (running) {
       stopJob();
    }
    graphics.fillRect(0,0,canvas.width,canvas.height);
    OSG.fillStyle="#BBBBBB";
    OSG.fillRect(0,0,canvas.width,canvas.height);
    imageData = OSG.getImageData(0,0,canvas.width,1);
    hres = Math.round(imageData.width/canvas.width);
    vres = imageData.height;
    dx = xmax.subtract(xmin).divide(new BigDecimal(""+(canvas.width-1)),BigDecimal.ROUND_HALF_EVEN);
    dy = ymax.subtract(ymin).divide(new BigDecimal(""+(canvas.height-1)),BigDecimal.ROUND_HALF_EVEN);
    highPrecision = dy.compareTo(HP_CUTOFF) < 0;
    jobs = [];
    var yVal = ymax.add(new BigDecimal("0"));
    var rows = canvas.height;
    var columns = canvas.width;
    savedIterationCounts = new Array(rows);
    savedIterationCounts2ndPass = new Array(rows+1);
    if (highPrecision) {
        digits = xmin.scale();
        chunks = Math.floor((digits * log2of10)/16 + 2);
        dxArray = new ArrayType(chunks+1);
        xminArray = new ArrayType(chunks+1);
        convert(xminArray, xmin, chunks+1);
        convert(dxArray,dx,chunks+1);
        for ( var row = 0; row < rows; row++) {
            var yValArray = new ArrayType(chunks+1);
            convert(yValArray, yVal, chunks+1);
            jobs[rows - 1- row] = {
                row: row,
                columns: columns,
                xmin: xminArray,
                dx: dxArray,
                yVal: yValArray
            };
            yVal = yVal.subtract(dy);
        }
    }
    else {
        var xmin_d = Number(xmin.toString());
        var ymax_d = Number(ymax.toString());
        var dx_d = Number(dx.toString());
        var dy_d = Number(dy.toString());
        var yVal_d = ymax_d;
        for ( var row = 0; row < rows; row++) {
            jobs[rows - 1- row] = {
                row: row,
                columns: columns,
                xmin: xmin_d,
                dx: dx_d,
                yVal: yVal_d
            };
            yVal_d = yVal_d - dy_d;
        }
    }
    if (interlaced) {
        var sortedJobs = jobs;
        jobs = [];
        for (var i = 0; i < interlaceOrder.length; i++) {
            for (var j = interlaceOrder[i]; j < sortedJobs.length; j += interlaceOrder.length) {
                jobs.push(sortedJobs[j]);
                //if (sortedJobs[j] == null) {  // for debugging
                //    throw "bad logic";
                //}
                //sortedJobs[j] = null;
            }
        }
    }
    jobsCompleted = 0;
    for (var i = 0; i < workerCount; i++) {
        var j = jobs.pop();
        j.workerNum = i;
        workers[i].postMessage(["setup",jobNum, maxIterations,highPrecision,i]);
        workers[i].postMessage([
            "task", j.row, j.columns,
            j.xmin, j.dx, j.yVal
        ]);
    }
    running = true;
    document.getElementById("stop").disabled = false;
    var prec = highPrecision? "high precision, " + digits + " digits" : "normal precision";
    document.getElementById("status").innerHTML = "Computing, " + prec + "...";
    repaintTimeout = setTimeout(repaint,333);
    timePerJob = -1;
    jobStartTime = new Date().getTime();
    state = COMPUTING_FIRST_PASS;
    currentXML = currentExampletoXML();
}

function jobFinished(msg) {
    var job = msg.data;
    if (job[0] != jobNum)
       return;
    if (jobs.length > 0) {
       var worker = workers[job[3]];
       var j = jobs.pop();
       worker.postMessage([
            "task", j.row, j.columns,
            j.xmin, j.dx, j.yVal
        ]);
    }
    timePerJob = ( (new Date().getTime()) - jobStartTime) / jobsCompleted;
    var iterationCounts = job[2];
    var row = job[1];
    if (state == COMPUTING_FIRST_PASS) {
       savedIterationCounts[row] = iterationCounts;
       putRow(row);
    }
    else {
       savedIterationCounts2ndPass[row] = iterationCounts;
       if (row > 0) {
           putRow(row-1);
       }
    }
    jobsCompleted++;
    if (state == COMPUTING_FIRST_PASS) {
        if (jobsCompleted == canvas.height) {
          state = DONE_FIRST_PASS;
          stopJob();
          if (document.getElementById("secondpass").checked) {
             startSecondPass();
          }
       }
    }
    else {
        if (jobsCompleted == canvas.height + 1) {
            state = IDLE;
            stopJob();
        }
    }
}

function startSecondPass() {
    if (running) {
       stopJob();
    }
    dx = xmax.subtract(xmin).divide(new BigDecimal(""+(canvas.width-1)),BigDecimal.ROUND_HALF_EVEN);
    dy = ymax.subtract(ymin).divide(new BigDecimal(""+(canvas.height-1)),BigDecimal.ROUND_HALF_EVEN);
    var dxHalf = dx.divide(TWO,BigDecimal.ROUND_HALF_EVEN);
    var dyHalf = dy.divide(TWO,BigDecimal.ROUND_HALF_EVEN);
    highPrecision = dy.compareTo(HP_CUTOFF) < 0;
    jobs = [];
    var yVal = ymax.add(dyHalf);
    var xStart = xmin.subtract(dxHalf);
    var rows = canvas.height + 1;
    var columns = canvas.width + 1;
    if (highPrecision) {
        digits = xmin.scale();
        chunks = Math.floor((digits * log2of10)/16 + 2);
        dxArray = new ArrayType(chunks+1);
        xminArray = new ArrayType(chunks+1);
        convert(xminArray, xStart, chunks+1);
        convert(dxArray,dx,chunks+1);
        for ( var row = 0; row < rows; row++) {
            var yValArray = new ArrayType(chunks+1);
            convert(yValArray, yVal, chunks+1);
            jobs[rows - 1- row] = {
                row: row,
                columns: columns,
                xmin: xminArray,
                dx: dxArray,
                yVal: yValArray
            };
            yVal = yVal.subtract(dy);
        }
    }
    else {
        var xmin_d = Number(xStart.toString());
        var dx_d = Number(dx.toString());
        var dy_d = Number(dy.toString());
        var yVal_d = Number(ymax.toString()) + dy_d/2;
        for ( var row = 0; row < rows; row++) {
            jobs[rows - 1- row] = {
                row: row,
                columns: columns,
                xmin: xmin_d,
                dx: dx_d,
                yVal: yVal_d
            };
            yVal_d = yVal_d - dy_d;
        }
    }
    jobsCompleted = 0;
    for (var i = 0; i < workerCount; i++) {
        var j = jobs.pop();
        j.workerNum = i;
        workers[i].postMessage(["setup",jobNum, maxIterations,highPrecision,i]);
        workers[i].postMessage([
            "task", j.row, j.columns,
            j.xmin, j.dx, j.yVal
        ]);
    }
    running = true;
    document.getElementById("stop").disabled = false;
    var prec = highPrecision? "high precision, " + digits + " digits" : "normal precision";
    document.getElementById("status").innerHTML = "Computing 2nd pass, " + prec + "...";
    repaintTimeout = setTimeout(repaint,500);
    timePerJob = -1;
    jobStartTime = new Date().getTime();
    state = COMPUTING_SECOND_PASS;
}

function putRow(row) {
    var iterationCounts = savedIterationCounts[row];
    var above = savedIterationCounts2ndPass[row];
    var below = savedIterationCounts2ndPass[row+1];
    var average = above && below;
    var secondPassColor;
    var ct;
    if (average) {
       ct = above[0];
       var c1 = ct < 0 ? [0,0,0] : paletteColors[ ct%paletteLength ];
       ct = below[0];
       var c2 = ct < 0 ? [0,0,0] : paletteColors[ ct%paletteLength ];
       secondPassColor = [c1[0]+c2[0],c1[1]+c2[1],c1[2]+c2[2]];
    }
    var columns = canvas.width;
    for (var i = 0; i < columns; i++) {
       ct = iterationCounts[i];
       var color;
       if (ct < 0) {
          color = [0,0,0];
       }
       else {
          var paletteIndex = iterationCounts[i] % paletteLength;
          color = paletteColors[paletteIndex];
       }
       if (average) {
           ct = above[i+1];
           var c1 = ct < 0 ? [0,0,0] : paletteColors[ ct%paletteLength ];
           ct = below[i+1];
           var c2 = ct < 0 ? [0,0,0] : paletteColors[ ct%paletteLength ];
           var secondPassColor2 = [c1[0]+c2[0],c1[1]+c2[1],c1[2]+c2[2]];
           color = [ // had a bug where I modified the color that was still in the palette array!
               ( 4*color[0] + secondPassColor[0] + secondPassColor2[0] ) / 8,
               ( 4*color[1] + secondPassColor[1] + secondPassColor2[1] ) / 8,
               ( 4*color[2] + secondPassColor[2] + secondPassColor2[2] ) / 8
           ];
           secondPassColor = secondPassColor2;
       }
       var p = 4*i*hres;
       for (var j = 0; j < hres; j++) {
           imageData.data[p] = color[0];
           imageData.data[p+1] = color[1];
           imageData.data[p+2] = color[2];
           imageData.data[p+3] = 255;
       }
    }
    for (var i = 0; i < vres; i++) {
        OSG.putImageData(imageData,0,row*vres+i);
    }
}

function setDefaults() {
    var oldXML = currentXML;
    stopJob();
    setLimits(new BigDecimal("-2.2"), new BigDecimal("0.8"), new BigDecimal("-1.2"), new BigDecimal("1.2"), false);
    stretchPalette = false;
    fixedPaletteLength = 250;
    maxIterations = 250;
    paletteOffsetFraction = 0;
    palette = new Palette();
    createPaletteColors();
    document.getElementById("maxIterSelect").value = "250";
    document.getElementById("custommaxiter").style.display = "none";
    document.getElementById("custompallen").style.display = "none";
    document.getElementById("custoffset").style.display = "none";
    document.getElementById("customsize").style.display = "none";
    document.getElementById("paletteLengthSelect").value = "250";
    document.getElementById("paletteOffsetSelect").value = "0";
    document.getElementById("standardPaletteSelect").value = "Spectrum";
    document.getElementById("imagesize").value = "Auto";
    autoResizeCanvas = true;
    doAutoSize(false);
    startJob();
    if (undoList) {
        addUndoItem("Restore Defaults", oldXML, currentXML);
    }
}

function remapColors() {
    for (var row = 0; row < canvas.height; row++) {
       if (savedIterationCounts[row]) {
           putRow(row);
       }
    }
    doDraw();
    currentXML = currentExampletoXML();
}

function createPaletteColors() {
    var length = stretchPalette ? maxIterations : fixedPaletteLength;
    paletteLength = length;
    var offset = Math.round(paletteOffsetFraction * paletteLength);
    paletteColors = palette.makeRGBs(paletteLength,offset);
}

function DragBox(x,y) {
    this.x = this.left = x;
    this.y = this.top = y;
    this.width = 0;
    this.height = 0;
}
DragBox.prototype.draw = function() {  // Draw the box on the on-screen canvas
    graphics.strokeStyle = "#FFFFFF";
    graphics.lineWidth = 4;
    graphics.strokeRect(this.left,this.top,this.width,this.height);
    graphics.strokeStyle = "#000000";
    graphics.lineWidth = 2;
    graphics.strokeRect(this.left,this.top,this.width,this.height);
}
DragBox.prototype.setCorner = function(x1,y1) {
    var w = Math.abs(x1 - this.x);
    var h = Math.abs(y1 - this.y);
    if (w < 3 || h < 3) {
        this.width = this.height = 0;
        return;
    }
    var aspect = canvas.width/canvas.height;
    var rectAspect = w / h;
    if (aspect > rectAspect)
        w = Math.round(w*aspect/rectAspect);
    else if (aspect < rectAspect)
        h = Math.round(h*rectAspect/aspect);
    if (this.x < x1) {
        this.left = this.x;
    }
    else {
        this.left = this.x - w;
    }
    if (this.y < y1) {
        this.top = this.y;
    }
    else {
        this.top = this.y - h;
    }
    this.width = w;
    this.height = h;
}
DragBox.prototype.zoom = function(zoomin) {
    if (this.width <= 2 || this.height <= 2)
       return;
    stopJob();
    if (zoomin == false) {
        doZoomOutFromRect(this.left, this.top, this.width, this.height);
    }
    else {
        doZoomInOnRect(this.left, this.top, this.width, this.height);
    }
    startJob();
}

function doZoomInOnRect(x,y,width,height) {
    var rectX = new BigDecimal("" + Math.round(x));  // (Firefox can have fractional parts)
    var rectY = new BigDecimal("" + Math.round(y));
    var rectW = new BigDecimal("" + Math.round(width));
    var rectH = new BigDecimal("" + Math.round(height));
    var ImageWidth = new BigDecimal("" + canvas.width);
    var ImageHeight = new BigDecimal("" + canvas.height);
    var pixelWidth = xmax.subtract(xmin).divide(ImageWidth,BigDecimal.ROUND_HALF_EVEN);
    var pixelHeight = ymax.subtract(ymin).divide(ImageHeight,BigDecimal.ROUND_HALF_EVEN);
    var newXmin,newXmax,newYmin,newYmax;
    newXmin = xmin.add(pixelWidth.multiply(rectX));
    newYmax = ymax.subtract(pixelHeight.multiply(rectY));
    var newWidth = pixelWidth.multiply(rectW);
    var newHeight = pixelHeight.multiply(rectH);
    newXmax = newXmin.add(newWidth);
    newYmin = newYmax.subtract(newHeight);
    setLimits(newXmin, newXmax, newYmin, newYmax, true);
}

function doZoomOutFromRect(x,y,width,height) {
    var rectX = new BigDecimal("" + Math.round(x));
    var rectY = new BigDecimal("" + Math.round(y));
    var rectW = new BigDecimal("" + Math.round(width));
    var rectH = new BigDecimal("" + Math.round(height));
    var ImageWidth = new BigDecimal("" + canvas.width);
    var ImageHeight = new BigDecimal("" + canvas.height);
    var newPixelWidth = xmax.subtract(xmin).divide(rectW,BigDecimal.ROUND_HALF_EVEN);
    var newPixelHeight = ymax.subtract(ymin).divide(rectH,BigDecimal.ROUND_HALF_EVEN);
    var newXmin,newXmax,newYmin,newYmax;
    newXmin = xmin.subtract(newPixelWidth.multiply(rectX));
    newYmax = ymax.add(newPixelHeight.multiply(rectY));
    var newWidth = newPixelWidth.multiply(ImageWidth);
    var newHeight = newPixelHeight.multiply(ImageHeight);
    newXmax = newXmin.add(newWidth);
    newYmin = newYmax.subtract(newHeight);
    setLimits(newXmin, newXmax, newYmin, newYmax, true);
}

function zoom(x, y, zoomFactor, recenter) {  // (x,y) is center of zoom, in pizels; recenter moves that point to center of image
    stopJob();
    var zf = new BigDecimal("" + zoomFactor);
    var X = new BigDecimal("" + Math.round(x));
    var Y = new BigDecimal("" + Math.round(y));
    var ImageWidth = new BigDecimal("" + canvas.width);
    var ImageHeight = new BigDecimal("" + canvas.height);
    var oldWidth = xmax.subtract(xmin);
    var oldHeight = ymax.subtract(ymin);
    var newWidth = oldWidth.multiply(zf);
    var newHeight = oldHeight.multiply(zf);
    if (newWidth.compareTo(new BigDecimal("100")) > 0) {
        document.getElementById("status").innerHTML =
            "Zooming out that far would reduce the whole Mandelbrot set to a dot.  Ignored.";
        return;
    }
    var pixelWidth = newWidth.divide(ImageWidth,BigDecimal.ROUND_HALF_EVEN);
    var pixelHeight = newHeight.divide(ImageHeight,BigDecimal.ROUND_HALF_EVEN);
    var centerX = xmin.add(X.multiply(oldWidth).divide(ImageWidth,BigDecimal.ROUND_HALF_EVEN));
    var centerY = ymax.subtract(Y.multiply(oldHeight).divide(ImageHeight,BigDecimal.ROUND_HALF_EVEN));
    var newXmin,newXmax,newYmin,newYmax;
    if (recenter) {
        newXmin = centerX.subtract(newWidth.divide(TWO,BigDecimal.ROUND_HALF_EVEN));
        newYmax = centerY.add(newHeight.divide(TWO,BigDecimal.ROUND_HALF_EVEN));
    }
    else {
        newXmin = centerX.subtract(X.multiply(pixelWidth));
        newYmax = centerY.add(Y.multiply(pixelHeight));
    }
    newYmin = newYmax.subtract(newHeight);
    newXmax = newXmin.add(newWidth);
    setLimits(newXmin, newXmax, newYmin, newYmax, true);
    startJob();
}


function setUpDragging() {
    var zoomin;
    var dragging = false; // for mouse only, to delay dragging until mouse moves.
    var startX, startY; // for mouse only
    dragbox = null;  // initially, the mouse is not being dragged.
    function startDrag(clientX,clientY) {
        var r = canvas.getBoundingClientRect();
        var x = clientX - r.left;
        var y = clientY - r.top;
        dragbox = new DragBox(x,y);
        doDraw();
    }
    function continueDrag(clientX,clientY) {
        var r = canvas.getBoundingClientRect();
        var x = clientX - r.left;
        var y = clientY - r.top;
        dragbox.setCorner(x,y);
        doDraw();
    }
    function endDrag() {
        dragbox.zoom(zoomin);
        dragbox = null;
    }
    function doMouseDoubleClick(evt) {
        if (dragbox || evt.button != 0) {
            return;
        }
        var r = canvas.getBoundingClientRect();
        var x = evt.clientX - r.left;
        var y = evt.clientY - r.top;
        var zoomFactor = evt.shiftKey? 2 : 0.5;
        zoom(x,y,zoomFactor,!evt.altKey);
    }
    function doMouseDown(evt) {
        if (dragging || evt.button != 0) {
            return;
        }
        dragging = true;
        startX = evt.clientX;
        startY = evt.clientY;
        dragbox = null;
        zoomin = !evt.shiftKey;
        canvas.addEventListener("mousemove",doMouseMove,false);
        document.addEventListener("mouseup",doMouseUp,false);
    }
    function doMouseMove(evt) {
        if (!dragging) {
            return;
        }
        if (dragbox == null) {
            if ( Math.abs(startX - evt.clientX) < 3 && Math.abs(startY - evt.clientY) < 3) {
                return;  // don't start drag until mouse has moved a bit.
            }
            startDrag(startX,startY);
        }
        continueDrag(evt.clientX,evt.clientY);
    }
    function doMouseUp(evt) {
        if (dragging) {
            dragging = false;
            if (dragbox) {
                endDrag();
            }
            canvas.removeEventListener("mousemove",doMouseMove,false);
            document.removeEventListener("mouseup",doMouseUp,false);
        }
    }
   function doTouchStart(evt){
        if (evt.touches.length != 1) {
           doTouchCancel();
           return;
        }
        if (dragbox) {
            return;
        }
        canvas.addEventListener("touchmove", doTouchMove);
        canvas.addEventListener("touchend", doTouchEnd);
        canvas.addEventListener("touchcancel", doTouchCancel);
        startDrag(evt.touches[0].clientX, evt.touches[0].clientY);
        evt.preventDefault();
    }
    function doTouchMove(evt){
        if (!dragbox)
           return;
        if (evt.touches.length != 1) {
           doTouchCancel();
           return;
        }
        continueDrag(evt.touches[0].clientX, evt.touches[0].clientY);
        evt.preventDefault();
    }
    function doTouchEnd(evt) {
        doTouchCancel();
    }
    function doTouchCancel() {
        if (dragbox) {
           canvas.removeEventListener("touchmove", doTouchMove);
           canvas.removeEventListener("touchend", doTouchEnd);
           canvas.removeEventListener("touchcancel", doTouchCancel);
           endDrag();
        }
    }
    canvas.addEventListener("mousedown",doMouseDown,false);
    canvas.addEventListener("dblclick",doMouseDoubleClick,false);
    canvas.addEventListener("touchstart",doTouchStart,false);
 }

function changeWorkerCount() {
    var ct = Number(document.getElementById("threadCountSelect").value);
    if (workers && ct == workers.length)
       return;
    var restart  = running;
    if (running) {
        stopJob();
    }
    workerCount = ct;
    newWorkers(ct);
    if (restart) {
        startJob();
    }
    try {
      if (window.sessionStorage) {
          window.sessionStorage.mandelbrotWorkerCount = "" + ct;
      }
    }
    catch(e) {
    }
}

function changeMaxIterations() {
    var val = document.getElementById("maxIterSelect").value;
    var iter;
    if (val == "Custom") {
        document.getElementById("maxiterinput").value = "" + maxIterations;
        document.getElementById("custommaxiter").style.display = "inline";
    }
    else {
        document.getElementById("custommaxiter").style.display = "none";
        iter = Number(val);
        setMaxIterations(iter);
    }
}
function setMaxIterations(iter) {
    if (iter == maxIterations)
       return;
    var oldval = maxIterations;
    stopJob();
    maxIterations = iter;
    createPaletteColors();
    startJob();
    addUndoItem("Change MaxIterations", oldval, maxIterations);
}
function doCustomMaxIterations() {
    var iter = Math.round(Number(document.getElementById("maxiterinput").value.trim()));
    if (isNaN(iter) || iter < 10) {
        document.getElementById("status").innerHTML = "Illegal value for max iterations.  Must be an integer greater than 9.";
        return;
    }
    setMaxIterations(iter);
}


function changePaletteLength() {
    var val = document.getElementById("paletteLengthSelect").value;
    var len;
    if (val == "Custom") {
        var length = stretchPalette ? maxIterations : fixedPaletteLength;
        stretchPalette = false;
        fixedPaletteLength = length;
        document.getElementById("palleninput").value = "" + length;
        document.getElementById("custompallen").style.display = "inline";
    }
    else if (val == "Match") {
        var oldval = [stretchPalette, paletteLength];
        stretchPalette = true;
        if (paletteLength != maxIterations) {
            stopJob();
            createPaletteColors();
            startJob();
            addUndoItem("Change PaletteLength", oldval, [stretchPalette,paletteLength]);
        }
        document.getElementById("custompallen").style.display = "none";
    }
    else {
       len = parseInt(val);
       if (len != paletteLength) {
          addUndoItem("Change PaletteLength", [stretchPalette, paletteLength], [false,len]);
       }
       setFixedPaletteLength(len);
       document.getElementById("custompallen").style.display = "none";
    }
}
function setFixedPaletteLength(len) {
    fixedPaletteLength = len;
    stretchPalette = false;
    if (fixedPaletteLength != paletteLength) {
       createPaletteColors();
       remapColors();
    }
}
function doCustomPaletteLength() {
    var val = Math.round(Number(document.getElementById("palleninput").value.trim()));
    if (isNaN(val) || val < 1) {
        document.getElementById("status").innerHTML = "Illegal value for number of colors.  Must be an integer greater than zero.";
        return;
    }
    setFixedPaletteLength(val);
}

function changePaletteOffset() {
    var val = document.getElementById("paletteOffsetSelect").value;
    if (val == "Custom") {
        var current = 100 * paletteOffsetFraction;
        document.getElementById("offsetinput").value = (current == Math.round(current))? current : current.toPrecision(3);
        document.getElementById("custoffset").style.display = "inline";
    }
    else {
        var fractionOffset = Number(val);
        setPaletteOffset(fractionOffset);
        document.getElementById("custoffset").style.display = "none";
    }
}
function doApplyCustomPaletteOffset() {
    var val = Number(document.getElementById("offsetinput").value.trim());
    if (isNaN(val) || val < 0 || val > 100) {
        document.getElementById("status").innerHTML =
             "Illegal value for percentage offset.  Must be a number in the range 0 to 100.";
    }
    else {
       setPaletteOffset(val/100);
    }
}
function setPaletteOffset(fractionOffset) {
    document.getElementById("status").innerHTML = "";
    if (fractionOffset == paletteOffsetFraction) {
        return;
    }
    addUndoItem("Change PaletteOffset", paletteOffsetFraction, fractionOffset);
    paletteOffsetFraction = fractionOffset;
    createPaletteColors();
    remapColors();
}

function changeInterlaced() {
   var checked = document.getElementById("interlaced").checked;
   if (checked == interlaced) {
       retrun;
   }
   interlaced = checked;
   if (running) {
       stopJob();
       startJob();
   }
}

function changeImageSize() {
    var val = document.getElementById("imagesize").value;
    autoResizeCanvas = false;
    if (val == "Custom") {
        document.getElementById("customwidth").value = "" + canvas.width;
        document.getElementById("customheight").value = "" + canvas.height;
        document.getElementById("customsize").style.display = "inline";
    }
    else if (val == "Auto") {
        document.getElementById("customsize").style.display = "none";
        doAutoSize(true);
        autoResizeCanvas = true;
    }
    else {
        document.getElementById("customsize").style.display = "none";
        var sizes = val.split(" ");
        var width = Number(sizes[0]);
        var height = Number(sizes[1]);
        setImageSize(width,height,true);
    }
}
function setImageSize(w,h,recordUndo) {
    if (w == canvas.width && h == canvas.height) {
        return;
    }
    var oldval = [canvas.width,canvas.height];
    stopJob();
    canvas.width = w;
    canvas.height = h;
    OSC.width = w;
    OSC.height = h;
    checkAspect();
    startJob();
    if (recordUndo) {
        addUndoItem("Change Image Size", oldval, [canvas.width,canvas.height]);
    }
}
function doCustomSize() {
    var width = Math.round(Number(document.getElementById("customwidth").value.trim()));
    var height = Math.round(Number(document.getElementById("customheight").value.trim()));
    if (isNaN(width) || width < 50 || width > 2500) {
        document.getElementById("status").innerHTML = "Illegal value for image width.  Must be an integer in the range 50 to 2500.";
        return;
    }
    if (isNaN(height) || height < 50 || height > 2500) {
        document.getElementById("status").innerHTML = "Illegal value for image height.  Must be an integer in the range 50 to 2500.";
        return;
    }
    setImageSize(width,height,true);
}
function doAutoSize(recordUndo) {
    var width = Math.min(800, window.innerWidth, Math.floor(window.innerHeight * 4 / 3));
    var height = Math.floor(width * 3 / 4);
    setImageSize(width,height,recordUndo);
}
function onResize() {
    if (resizeTimeout) {
        clearTimeout(resizeTimeout);
        resizeTimeout = false;
    }
    if (autoResizeCanvas) {
        resizeTimeout = setTimeout(function() {
            resizeTimeout = false;
            doAutoSize(false);
        },500);
    }
}

function doApplyStandardPalette() {
    var name = document.getElementById("standardPaletteSelect").value;
    var oldval = palette;
    palette = Palette.createStandardPalette(name);
    createPaletteColors();
    remapColors();
    addUndoItem("Change Palette", oldval, palette);
}

function changeSecondPass() {
    var checked = document.getElementById("secondpass").checked;
    if (checked && !running && state == DONE_FIRST_PASS) {
        startSecondPass();
    }
}

function doZoomIn() {
    zoom(canvas.width/2, canvas.height/2, document.getElementById("zoomInAmount").value, false);
}

function doZoomOut() {
    zoom(canvas.width/2, canvas.height/2, document.getElementById("zoomOutAmount").value, false);
}

//---------------------- Undo/Redo ---------------------------------------

function doUndo() {
    if (undoCount > 0) {
        var item = undoList[undoCount-1];
        undoCount--;
        document.getElementById("undo").disabled = (undoCount == 0);
        document.getElementById("undo").getElementsByTagName("span")[0].innerHTML = undoCount? ("Undo " + undoList[undoCount-1].name) : "Undo (not possible)";
        document.getElementById("redo").disabled = false;
        document.getElementById("redo").getElementsByTagName("span")[0].innerHTML = "Redo " + item.name;
        applyUndoItem(item.name, item.oldValue);
    }
}

function doRedo() {
    if (undoCount < undoList.length) {
        var item = undoList[undoCount];
        undoCount++;
        document.getElementById("undo").disabled = false;
        document.getElementById("undo").getElementsByTagName("span")[0].innerHTML = "Undo " + item.name;
        document.getElementById("redo").disabled = (undoCount == undoList.length);
        document.getElementById("redo").getElementsByTagName("span")[0].innerHTML = (undoCount < undoList.length)? ("Redo " + undoList[undoCount].name) : "Redo (not possible)";
        applyUndoItem(item.name, item.newValue);
    }
}

function addUndoItem(name, oldValue, newValue) {
    if (applyUndoInProgress) {
        return;
    }
    undoList.length = undoCount;
    undoList.push( { name: name, oldValue: oldValue, newValue: newValue } );
    if (undoList.length > 100) {
        undoList.shift();
    }
    undoCount = undoList.length;
    document.getElementById("undo").disabled = false;
    document.getElementById("undo").getElementsByTagName("span")[0].innerHTML = "Undo " + name;
    document.getElementById("redo").disabled = true;
    document.getElementById("redo").getElementsByTagName("span")[0].innerHTML = "Redo";
}

function applyUndoItem(name, value) {
    applyUndoInProgress = true;
    switch (name) {
      case "Restore Defaults":
      case "Import Example":
         installExampleFromXML(value,false,true);
         break;
      case "Change PaletteOffset":
         paletteOffsetFraction = value;
         createPaletteColors();
         remapColors();
         if ([0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9].indexOf(value) < 0) {
              document.getElementById("paletteOffsetSelect").value = "Custom";
              document.getElementById("custoffset").style.display = "inline";
              value *= 100;
              document.getElementById("offsetinput").value = (value == Math.round(value))? value : value.toPrecision(3);
         }
         else {
              document.getElementById("paletteOffsetSelect").value = "" + value;
              document.getElementById("custoffset").style.display = "none";
         }
         break;
      case "Change Limits":
         stopJob();
         setLimits(value[0],value[1],value[2],value[3],false);
         startJob();
         break;
      case "Change Image Size":
         setImageSize(value[0],value[1],false);
         var val = value[0] + " " + value[1];
         if (["200 150", "400 300", "640 480", "800 600", "1024 768", "1200 900", "1600 900", "425 550", "850 1100"].indexOf(val) < 0) {
             document.getElementById("imagesize").value = "Custom";
             document.getElementById("customsize").style.display = "inline";
             document.getElementById("customwidth").value = "" + value[0];
             document.getElementById("customheight").value = "" + value[1];
         }
         else {
             document.getElementById("imagesize").value = val;
             document.getElementById("customsize").style.display = "none";
         }
         break;
      case "Change PaletteLength":
         if (value[0]) {
            stretchPalette = true;
            document.getElementById("paletteLengthSelect").value = "Match MaxIter";
            document.getElementById("custompallen").style.display = "none";
         }
         else  {
             stretchPalette = false;
             fixedPaletteLength = value[1];
             if ([50,100,250,500,1000,2500,5000].indexOf(value[1]) < 0) {
                document.getElementById("custompallen").style.display = "inline";
                document.getElementById("paletteLengthSelect").value = "Custom";
                document.getElementById("palleninput").value = "" + value[1];
             }
             else {
                document.getElementById("custompallen").style.display = "none";
                document.getElementById("paletteLengthSelect").value = "" + value[1];
             }
         }
         createPaletteColors();
         remapColors();
         break;
      case "Change MaxIterations":
         setMaxIterations(value);
         if ([25,50,100,250,500,1000,2500,5000,10000,25000,50000].indexOf(value) < 0) {
             document.getElementById("custommaxiter").style.display = "inline";
             document.getElementById("maxIterSelect").value = "Custom";
             document.getElementById("maxiterinput").value = "" + value;
         }
         else {
             document.getElementById("custommaxiter").style.display = "none";
             document.getElementById("maxIterSelect").value = "" + value;
         }
         break;
      case "Change Palette":
         palette = value;
         createPaletteColors();
         remapColors();
         break;
    }
    applyUndoInProgress = false;
}

//--------------------- Palette ------------------------------------------
function Palette(colorType,divisionPoints,colors) {
   this.colorType = colorType || "HSB";
   this.divisionPoints = divisionPoints || [0,1];
   this.divisionColors = colors || (this.colorType == "HSB" ? [ [0,1,1], [1,1,1] ] : [ [1,1,1], [0,0,0] ]);
}
Palette.prototype.getColor = function(position) {  // 0.0 <= position <= 1.0
    var pt = 1;
    while (position > this.divisionPoints[pt])
        pt++;
    var ratio = (position - this.divisionPoints[pt-1]) /
                   (this.divisionPoints[pt] - this.divisionPoints[pt-1]);
    var c1 = this.divisionColors[pt-1];
    var c2 = this.divisionColors[pt];
    var a = c1[0] + ratio*(c2[0] - c1[0]);
    var b = c1[1] + ratio*(c2[1] - c1[1]);
    var c = c1[2] + ratio*(c2[2] - c1[2]);
    return this.toRGB(a,b,c);
}
Palette.prototype.toRGB = function(a,b,c) {  // 3 non-clamped color components.
    a = (this.colorType == "HSB")? (a - Math.floor(a)) : clamp(a);
    b = clamp(b);
    c = clamp(c);
    var color;
    if (this.colorType == "HSB")
        color = rgbFromHSV(a, b, c);
    else
        color = [a,b,c];
    color[0] = Math.round(color[0]*255);
    color[1] = Math.round(color[1]*255);
    color[2] = Math.round(color[2]*255);
    return color;
	function clamp(x) {
		x = 2*(x/2 - Math.floor(x/2));
		if (x > 1)
			x = 2 - x;
		return x;
	}
    function rgbFromHSV(h,s,v) {  // all components in range 0 to 1
        h *= 360;
        var r,g,b;
        var c,x;
        c = v*s;
        x = (h < 120)? h/60 : (h < 240)? (h-120)/60 : (h-240)/60;
        x = c * (1-Math.abs(x-1));
        x += (v-c);
        switch (Math.floor(h/60)) {
            case 0: r = v; g = x; b = v-c; break;
            case 1: r = x; g = v; b = v-c; break;
            case 2: r = v-c; g = v; b = x; break;
            case 3: r = v-c; g = x; b = v; break;
            case 4: r = x; g = v-c; b = v; break;
            case 5: r = v; g = v-c; b = x; break;
        }
        return [r,g,b];
    }
}
Palette.prototype.makeRGBs = function(paletteLength, offset) {
    var rgb = new Array(paletteLength);
    rgb[offset % paletteLength] =
             this.toRGB(this.divisionColors[0][0],this.divisionColors[0][1],this.divisionColors[0][2]);
    var dx = 1.0 / (paletteLength-1);
    for (var i = 1; i < paletteLength-1; i++) {
        rgb[(offset+i) % paletteLength] = this.getColor(i*dx);
    }
    var last = this.divisionColors.length - 1;
    rgb[(offset+paletteLength-1) % paletteLength] =
              this.toRGB(this.divisionColors[last][0],this.divisionColors[last][1],this.divisionColors[last][2]);
    return rgb;
}
Palette.prototype.toXMLString = function() {
   var xml = "<palette colorType='" + this.colorType + "'>\n";
   for (var i = 0; i < this.divisionPoints.length; i++) {
       xml += "   <divisionPoint position='" + this.divisionPoints[i] + "' color='" +
            this.divisionColors[i][0] + ";" + this.divisionColors[i][1] + ";" +this.divisionColors[i][2] +
            "'/>\n";
   }
   xml += "</palette>\n";
   return xml;
}
Palette.fromXML = function( paletteNode ) {  // can throw an exception
    try {
       var children = paletteNode.childNodes;
       var type = paletteNode.getAttribute("colorType") || "RBG";
       if (type != "HSB" && type != "RGB") {
           throw "Bad colorType.";
       }
       var points = [];
       var colors = [];
       for (var i = 0; i < children.length; i++) {
          var child = children.item(i);
          if (child.nodeType == 1 && child.tagName == "divisionPoint") { // element node
              var pt = child.getAttribute("position");
              var rgb = child.getAttribute("color");
              if (pt === null || rgb === null) {
                  throw "Missing data for divisionPoint";
              }
              pt = Number(pt);
              rgb = rgb.split(";");
              rgb = [Number(rgb[0]),Number(rgb[1]),Number(rgb[2])];
              if (isNaN(pt) || pt < 0 || pt > 1) {
                   throw "Bad data for divisionPoint";
              }
              for (var j = 0; j < 3; j++) {
                   if (isNaN(rgb[j]) || rgb[j] < 0 ){
                      throw "Bad data for divisionPoint color";
                   }
              }
              if (i > 0 && pt <= points[points.length-1]) {
                  throw "Division points out of order";
              }
              points.push(pt);
              colors.push(rgb);
          }
       }
       if (points.length < 2 || points[0] != 0 || points[points.length-1] != 1) {
           throw "Illegal divisionPoint data"
       }
       return new Palette(type, points, colors);
    }
    catch (e) {
        throw "Illegal palette definition: " + e;
    }
}
Palette.createStandardPalette = function(name) {
    var palette;
    switch (name) {
        case "Grayscale":
           palette = new Palette("RGB");
           break;
        case "CyclicGrayscale":
           palette = new Palette("RGB",[0,0.5,1],[[0,0,0],[1,1,1],[0,0,0]]);
           break;
        case "Red/Cyan":
           palette = new Palette("RGB",[0,0.5,1],[[1,0,0],[0,1,1],[1,0,0]]);
           break;
        case "Blue/Gold":
           palette = new Palette("RGB",[0,0.5,1],[[0.1,0.1,1],[1,0.6,0],[0.3,0.3,1]]);
           break;
        case "EarthAndSky":
           palette = new Palette("RGB",[0,0.15,0.33,0.67,0.85,1],
                     [[1,1,1],[1,0.8,0],[0.53,0.12,0.075],[0,0,0.6],[0,0.4,1],[1,1,1]]);
           break;
        case "HotAndCold":
           palette = new Palette("RGB",[0,0.16,0.5,0.84,1],
                     [[1,1,1],[0,0.4,1],[0.2,0.2,0.2],[1,0,0.8],[1,1,1]]);
           break;
        case "Fire":
           palette = new Palette("RGB",[0,0.17,0.83,1],
                     [[0,0,0],[1,0,0],[1,1,0],[1,1,1]]);
           break;
        case "TreeColors":
           palette = new Palette("HSB",[0,0.33,0.66,1],
                     [[0.1266,0.5955,0.2993],[0.0896,0.3566,0.6575],[0.6195,0.8215,0.4039],[0.1266,0.5955,0.2993]]);
           break;
        case "Seashore":
           palette = new Palette("RGB",[0,0.1667,0.3333,0.5,0.6667,0.8333,1],
                     [[0.7909,0.9961,0.7630],[0.8974,0.8953,0.6565],[0.9465,0.3161,0.1267],[0.5184,0.1109,0.0917],
                              [0.0198,0.4563,0.6839],[0.5385,0.8259,0.8177],[0.7909,0.9961,0.7630]]);
           break;
        case "Random":
           var c = [Math.random(),Math.random(),Math.random()];
           palette = new Palette("RGB",[],[]);
           palette.divisionPoints[0] = 0;
           palette.divisionColors[0] = c;
           for (var i = 1; i <= 5; i++) {
               palette.divisionPoints[i] = i/6;
               palette.divisionColors[i] = [Math.random(),Math.random(),Math.random()];
           }
           palette.divisionPoints[6] = 1;
           palette.divisionColors[6] = c;
           break;
        default: // "Spectrum"
           palette = new Palette();
    }
    return palette;
}

//-------------------------------------------------------------------------------------------

function currentExampletoXML() {
    var offset = Math.round(paletteOffsetFraction * paletteLength);
    return "<?xml version='1.0'?>\n<mandelbrot_settings_2>\n" +
            "<image_size width='" + canvas.width + "' height='" + canvas.height + "'/>\n" +
            "<limits>\n   <xmin>" + xmin_requested.toString() + "</xmin>\n" +
            "   <xmax>" + xmax_requested.toString() + "</xmax>\n" +
            "   <ymin>" + ymin_requested.toString() + "</ymin>\n" +
            "   <ymax>" + ymax_requested.toString() + "</ymax>\n</limits>\n" +
            palette.toXMLString() +
            "<palette_mapping length='" + paletteLength + "' offset='" + offset + "'/>\n" +
            "<max_iterations value='" + maxIterations + "'/>\n" +
            "</mandelbrot_settings_2>\n";
}

function installExampleFromXML(xmlString, recordUndo, respectSize) {
    var oldXML = currentXML;
    stopJob();
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xmlString,"text/xml").documentElement;
      var width,height,xmin,xmax,ymin,ymax,colors,length,offset,iterations;
      if (respectSize) {
          var size = doc.getElementsByTagName("image_size");
          if (size == 0) {
              respectSize = false;
          }
          else {
              width = Number(size[0].getAttribute("width"));
              height = Number(size[0].getAttribute("height"));
              if (isNaN(width) || width > 2500 || width < 50 || isNaN(height) || height > 2500 || height < 50) {
                   respectSize = false;
              }
          }
      }
      xmin = doc.getElementsByTagName("xmin").item(0).textContent;
      xmax = doc.getElementsByTagName("xmax").item(0).textContent;
      ymin = doc.getElementsByTagName("ymin").item(0).textContent;
      ymax = doc.getElementsByTagName("ymax").item(0).textContent;
      colors = Palette.fromXML( doc.getElementsByTagName("palette").item(0));
      var map = doc.getElementsByTagName("palette_mapping");
      if (map.length > 0) {
          length = Number(map.item(0).getAttribute("length"));
          offset = Number(map.item(0).getAttribute("offset"));
      }
      else {
          length = 250;
          offset = 0;
      }
      iterations = Number(doc.getElementsByTagName("max_iterations").item(0).getAttribute("value"));
      xmin = new BigDecimal(xmin);
      xmax = new BigDecimal(xmax);
      ymin = new BigDecimal(ymin);
      ymax = new BigDecimal(ymax);
      if (isNaN(length) || isNaN(offset) || isNaN(iterations)) {
          throw "Bad number.";
      }
      if (length == 0) {
          length = iterations;
      }
      palette = colors;
      maxIterations = Math.round(iterations);
      if ([25,50,100,250,500,1000,2500,5000,10000,25000,50000].indexOf(maxIterations) < 0) {
          document.getElementById("custommaxiter").style.display = "inline";
          document.getElementById("maxIterSelect").value = "Custom";
          document.getElementById("maxiterinput").value = "" + iterations;
      }
      else {
          document.getElementById("custommaxiter").style.display = "none";
          document.getElementById("maxIterSelect").value = "" + maxIterations;
      }
      length = Math.round(length);
      if (length == 0) {
         stretchPalette = true;
         document.getElementById("paletteLengthSelect").value = "Match MaxIter";
         document.getElementById("custompallen").style.display = "none";
      }
      else  {
          stretchPalette = false;
          fixedPaletteLength = length;
          if ([50,100,250,500,1000,2500,5000].indexOf(length) < 0) {
             document.getElementById("custompallen").style.display = "inline";
             document.getElementById("paletteLengthSelect").value = "Custom";
             document.getElementById("palleninput").value = "" + length;
          }
          else {
             document.getElementById("custompallen").style.display = "none";
             document.getElementById("paletteLengthSelect").value = "" + length;
          }
      }
      paletteOffsetFraction = offset/length;
      paletteOffsetFraction = paletteOffsetFraction - Math.floor(paletteOffsetFraction);
      paletteOffsetFraction = Math.round(10000*paletteOffsetFraction)/10000;
      if (offset == 0) {
           document.getElementById("custoffset").style.display = "none";
           document.getElementById("paletteOffsetSelect").value = "0";
      }
      else {
           document.getElementById("custoffset").style.display = "inline";
           document.getElementById("paletteOffsetSelect").value = "Custom";
           var current = 100*paletteOffsetFraction;
           document.getElementById("offsetinput").value = (current == Math.round(current))? current : current.toPrecision(3);
      }
      createPaletteColors();
      if (respectSize) {
         setImageSize(width,height,false);
         var val = width + " " + height;
         if (["200 150", "400 300", "640 480", "800 600", "1024 768", "1200 900", "1600 900", "425 550", "850 1100"].indexOf(val) < 0) {
             document.getElementById("imagesize").value = "Custom";
             document.getElementById("customsize").style.display = "inline";
             document.getElementById("customwidth").value = "" + width;
             document.getElementById("customheight").value = "" + height;
         }
         else {
             document.getElementById("imagesize").value = val;
             document.getElementById("customsize").style.display = "none";
         }
      }
      setLimits(xmin,xmax,ymin,ymax,false);
      startJob();
      if (recordUndo && undoList) {
          addUndoItem("Import Example", oldXML, currentXML);
      }
    }
    catch (e) {
        document.getElementById("status").innerHTML = "Illegal data in XML example string: " + e;
    }
}

function importXML() {
    document.getElementById("XMLtextinput").value = "";
    document.getElementById("xmlimportbg").style.display = "block";
    document.getElementById("xmlimport").style.display = "block";
    document.addEventListener("keydown", doKey, false);
    document.getElementById("cancelXMLimport").onclick = dismiss;
    document.getElementById("applyXMLimport").onclick = apply;
    document.getElementById("grabcurrent").onclick = grabCurrent;
    function apply() {
        var text = document.getElementById("XMLtextinput").value.trim();
        dismiss();
        if (text != "") {
            installExampleFromXML(text,true,false);
        }
    }
    function dismiss() {
        document.getElementById("xmlimportbg").style.display = "none";
        document.getElementById("xmlimport").style.display = "none";
        document.removeEventListener("keydown", doKey, false);
    }
    function grabCurrent() {
        document.getElementById("XMLtextinput").value = currentXML;
    }
    function doKey(evt) {
        var code = evt.keyCode;
        if (code == 27) {
            dismiss();
        }
    }
}

function downloadImage() {
    var a = document.createElement("a");
    a.href = canvas.toDataURL();
    if ("download" in a) {
        a.download = "mandelbrot.png";
    }
    else {
        a.target = "_blank";
    }
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function init() {
    try {
        canvas = document.getElementById("canvas");
        graphics = canvas.getContext("2d");
        OSC = document.createElement("canvas");
        OSC.width = canvas.width;
        OSC.height = canvas.height;
        OSG = OSC.getContext("2d");
    }
    catch (e) {
         document.getElementById("status").innerHTML =
             "Sorry, this page requires canvas support, which is not available in your browser.";
         return;
    }
    if (! window.Worker ) {
         document.getElementById("status").innerHTML =
             "Sorry, this page requires WebWorker support, which is not available in your browser.";
         return;
    }
    palette = new Palette();
    document.getElementById("restoreButton").onclick = setDefaults;
    document.getElementById("stop").onclick = stopJob;
    document.getElementById("interlaced").onchange = changeInterlaced;
    document.getElementById("interlaced").checked = interlaced;
    document.getElementById("imagesize").onchange = changeImageSize;
    document.getElementById("applysize").onclick = doCustomSize;
    try {
      if (window.sessionStorage && window.sessionStorage.mandelbrotWorkerCount) {
          var ct = Math.round(Number(window.sessionStorage.mandelbrotWorkerCount));
          if (!isNaN(ct) && ct > 0 && ct <= 8) {
              workerCount = ct;
          }
      }
    }
    catch(e) {
    }
    document.getElementById("threadCountSelect").value = "" + workerCount;
    document.getElementById("threadCountSelect").onchange = changeWorkerCount;
    document.getElementById("maxIterSelect").value = "100";
    document.getElementById("maxIterSelect").onchange = changeMaxIterations;
    document.getElementById("maxiterapply").onclick = doCustomMaxIterations;
    document.getElementById("paletteLengthSelect").onchange = changePaletteLength;
    document.getElementById("pallenapply").onclick = doCustomPaletteLength;
    document.getElementById("paletteOffsetSelect").onchange = changePaletteOffset;
    document.getElementById("offsetapply").onclick = doApplyCustomPaletteOffset;
    document.getElementById("standardPaletteSelect").value = "Spectrum";
    document.getElementById("standardPaletteSelect").onchange = doApplyStandardPalette;
    document.getElementById("secondpass").checked = true;
    document.getElementById("secondpass").onchange = changeSecondPass;
    document.getElementById("zoomInAmount").value = "0.1";
    document.getElementById("zoomOutAmount").value = "10";
    document.getElementById("zoomin").onclick = doZoomIn;
    document.getElementById("zoomout").onclick = doZoomOut;
    document.getElementById("importXML").onclick = importXML;
    document.getElementById("downloadImage").onclick = downloadImage;
    document.getElementById("undo").onclick = doUndo;
    document.getElementById("undo").disabled = true;
    document.getElementById("redo").onclick = doRedo;
    document.getElementById("redo").disabled = true;
    window.onresize = onResize;
    setUpDragging();
    changeWorkerCount(); // has to be done before setDefaults
    setDefaults();
    undoList = [];
    undoCount = 0;
}

init();
})();