#import <AppKit/AppKit.h>
#include <stdint.h>

@interface SbmMenu : NSObject <NSApplicationDelegate, NSMenuDelegate>
@property NSStatusItem *item;
@property NSMenuItem *stateItem;
@property NSTextField *stateLabel;
@property NSImageView *stateDot;
@property NSTextField *titleLabel;
@property NSMenuItem *toggleItem;
@property NSMenuItem *upgradeItem;
@property NSMenuItem *quitItem;
@property NSArray<NSMenuItem *> *vpsItems;
@property NSMenuItem *exitItem;
@property NSArray<NSMenuItem *> *exitChoices;
@property NSMenuItem *wpsItem;
@property NSSwitch *wpsSwitch;
@property BOOL wpsEnabled;
@property NSInteger wpsRevision;
@property BOOL loaded;
@property BOOL busy;
- (void)receive:(NSDictionary *)message;
@end

static SbmMenu *menu;
static NSMutableArray<NSNumber *> *actions;
static NSMutableArray<NSDictionary *> *pendingMessages;
static NSDictionary *lastModel;
static BOOL closing;
static int32_t authorizationCode;
static NSString *authorizationMessage;
static dispatch_queue_t authorizationQueue;
static BOOL interfaceTest;
static int32_t interfaceResult = 1;

static void initializeBridge(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        actions = [NSMutableArray array];
        pendingMessages = [NSMutableArray array];
        authorizationQueue = dispatch_queue_create("io.github.chendesheng.sbm.authorization", DISPATCH_QUEUE_SERIAL);
    });
}

static NSString *text(const uint8_t *bytes, size_t length) {
    return [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding] ?: @"";
}

// Explicit tracking mode keeps progress live while NSMenu runs its nested loop.
static void onMain(NSDictionary *message) {
    initializeBridge();
    SbmMenu *target;
    @synchronized ([SbmMenu class]) {
        target = menu;
        if (!target) { if (![message[@"kind"] isEqual:@"state"]) [pendingMessages addObject:message]; return; }
    }
    [target performSelectorOnMainThread:@selector(receive:) withObject:message waitUntilDone:NO
                                 modes:@[NSDefaultRunLoopMode, NSEventTrackingRunLoopMode, NSModalPanelRunLoopMode]];
}

static NSString *shellQuote(NSString *value) {
    return [NSString stringWithFormat:@"'%@'", [value stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"]];
}

static NSString *scriptQuote(NSString *value) {
    NSString *escaped = [value stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    return [NSString stringWithFormat:@"\"%@\"", escaped];
}

static void finishAuthorization(int32_t code, NSString *message) {
    @synchronized ([SbmMenu class]) { authorizationMessage = message ?: @""; authorizationCode = code; }
}

static NSImage *paperPlaneImage(void) {
    NSImage *image = [NSImage imageWithSize:NSMakeSize(20, 20) flipped:NO drawingHandler:^BOOL(NSRect rect) {
        [NSColor.blackColor setFill];
        NSBezierPath *plane = [NSBezierPath bezierPath];
        [plane moveToPoint:NSMakePoint(1, 8)];
        [plane lineToPoint:NSMakePoint(19, 17)];
        [plane lineToPoint:NSMakePoint(14, 3)];
        [plane lineToPoint:NSMakePoint(9, 5)];
        [plane lineToPoint:NSMakePoint(16, 14)];
        [plane lineToPoint:NSMakePoint(7, 6)];
        [plane closePath]; [plane fill];
        NSBezierPath *fold = [NSBezierPath bezierPath];
        [fold moveToPoint:NSMakePoint(8, 4.5)];
        [fold lineToPoint:NSMakePoint(10.5, 3.5)];
        [fold lineToPoint:NSMakePoint(7.5, 1)];
        [fold closePath]; [fold fill];
        return YES;
    }];
    image.template = YES;
    return image;
}

static NSImage *statusDot(NSColor *color) {
    return [NSImage imageWithSize:NSMakeSize(8, 8) flipped:NO drawingHandler:^BOOL(NSRect rect) {
        [color setFill]; [[NSBezierPath bezierPathWithOvalInRect:rect] fill]; return YES;
    }];
}

static BOOL containsFittingMenuTitle(NSView *view, NSString *title) {
    if ([view isKindOfClass:NSTextField.class]) {
        NSTextField *field = (NSTextField *)view;
        if ([field.stringValue isEqual:title]) return field.cell.cellSize.width <= field.bounds.size.width;
    }
    for (NSView *child in view.subviews) if (containsFittingMenuTitle(child, title)) return YES;
    return NO;
}

static BOOL menuTitleFits(NSString *title) {
    for (NSWindow *window in NSApp.windows) if (containsFittingMenuTitle(window.contentView, title)) return YES;
    return NO;
}

@implementation SbmMenu
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.item = [[NSStatusBar systemStatusBar] statusItemWithLength:NSSquareStatusItemLength];
    self.item.button.image = paperPlaneImage();
    self.item.button.imagePosition = NSImageOnly;
    self.item.button.accessibilityLabel = @"sbm";
    self.item.button.toolTip = @"sbm — checking sing-box";
    NSMenu *items = [[NSMenu alloc] initWithTitle:@"sbm"];
    items.autoenablesItems = NO;
    items.showsStateColumn = NO;
    items.delegate = self;
    self.stateItem = [items addItemWithTitle:@"Checking…" action:nil keyEquivalent:@""];
    NSView *header = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 260, 72)];
    NSImageView *appIcon = [[NSImageView alloc] initWithFrame:NSMakeRect(14, 12, 48, 48)];
    appIcon.image = [[NSImage alloc] initWithContentsOfFile:[[NSBundle mainBundle] pathForResource:@"AppIcon" ofType:@"icns"]];
    [header addSubview:appIcon];
    self.titleLabel = [NSTextField labelWithString:@"sbm"];
    self.titleLabel.frame = NSMakeRect(76, 37, 170, 23);
    self.titleLabel.font = [NSFont boldSystemFontOfSize:17];
    self.titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    [header addSubview:self.titleLabel];
    self.stateDot = [[NSImageView alloc] initWithFrame:NSMakeRect(77, 21, 8, 8)];
    self.stateDot.image = statusDot(NSColor.systemYellowColor); [header addSubview:self.stateDot];
    self.stateLabel = [NSTextField labelWithString:@"Checking…"];
    self.stateLabel.frame = NSMakeRect(90, 15, 156, 20);
    self.stateLabel.font = [NSFont systemFontOfSize:13]; self.stateLabel.textColor = NSColor.secondaryLabelColor;
    // Align the light with the visible capitals, rather than the text field's padding.
    CGFloat textCenter = NSMaxY(self.stateLabel.frame) - self.stateLabel.firstBaselineOffsetFromTop + self.stateLabel.font.capHeight / 2;
    [self.stateDot setFrameOrigin:NSMakePoint(77, textCenter - 4)];
    [header addSubview:self.stateLabel]; self.stateItem.view = header;
    self.stateItem.enabled = NO;
    [items addItem:[NSMenuItem separatorItem]];
    self.toggleItem = [items addItemWithTitle:@"Start" action:@selector(toggle:) keyEquivalent:@""];
    self.toggleItem.target = self; self.toggleItem.enabled = NO;
    self.upgradeItem = [items addItemWithTitle:@"" action:@selector(upgrade:) keyEquivalent:@""];
    self.upgradeItem.target = self; self.upgradeItem.enabled = NO; self.upgradeItem.hidden = YES;
    NSMenuItem *vpsSeparator = [NSMenuItem separatorItem];
    NSMenuItem *vpsHeader = [NSMenuItem sectionHeaderWithTitle:@"VPS"];
    [items addItem:vpsSeparator];
    [items addItem:vpsHeader];
    self.exitItem = [items addItemWithTitle:@"Exit" action:nil keyEquivalent:@""];
    if (@available(macOS 14.4, *)) self.exitItem.subtitle = @"Checking…";
    NSMenu *exits = [[NSMenu alloc] initWithTitle:@"Exit"];
    exits.autoenablesItems = NO;
    NSMutableArray *choices = [NSMutableArray array];
    NSArray *names = @[@"DMIT direct", @"Japan", @"Los Angeles"];
    for (NSInteger index = 0; index < names.count; index++) {
        NSMenuItem *choice = [exits addItemWithTitle:names[index] action:@selector(selectExit:) keyEquivalent:@""];
        choice.target = self; choice.tag = 10 + index; choice.enabled = NO;
        [choices addObject:choice];
    }
    self.exitChoices = choices; self.exitItem.submenu = exits;
    self.wpsItem = [items addItemWithTitle:@"WPS tunnel" action:@selector(toggleWps:) keyEquivalent:@""];
    self.wpsItem.target = self;
    NSView *wpsRow = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 280, 32)];
    wpsRow.autoresizingMask = NSViewWidthSizable;
    NSTextField *wpsTitle = [NSTextField labelWithString:@"WPS tunnel"];
    wpsTitle.font = [NSFont menuFontOfSize:0]; wpsTitle.frame = NSMakeRect(14, 7, 196, 18);
    wpsTitle.alignment = NSTextAlignmentLeft;
    [wpsRow addSubview:wpsTitle];
    self.wpsSwitch = [[NSSwitch alloc] initWithFrame:NSMakeRect(224, 4, 38, 24)];
    self.wpsSwitch.autoresizingMask = NSViewMinXMargin;
    self.wpsSwitch.controlSize = NSControlSizeSmall; self.wpsSwitch.enabled = NO;
    self.wpsSwitch.target = self; self.wpsSwitch.action = @selector(toggleWps:);
    self.wpsSwitch.accessibilityLabel = @"WPS tunnel";
    [wpsRow addSubview:self.wpsSwitch]; self.wpsItem.view = wpsRow;
    self.vpsItems = @[vpsSeparator, vpsHeader, self.exitItem, self.wpsItem];
    for (NSMenuItem *item in self.vpsItems) item.hidden = YES;
    [items addItem:[NSMenuItem separatorItem]];
    self.quitItem = [items addItemWithTitle:@"Quit sbm" action:@selector(quit:) keyEquivalent:@"q"];
    self.quitItem.target = self;
    self.item.menu = items;
    NSDictionary *model;
    @synchronized ([SbmMenu class]) { model = lastModel; }
    if (model) [self receive:model];
    NSArray *pending;
    @synchronized ([SbmMenu class]) { pending = [pendingMessages copy]; [pendingMessages removeAllObjects]; }
    for (NSDictionary *message in pending) [self receive:message];
    if (interfaceTest) {
        // Exercise the actual menu tracking loop with the preview worker. The
        // fixture has no access to service controls or administrator requests.
        __block NSString *previousTitle = nil;
        __block NSUInteger changes = 0;
        __block BOOL sawChecking = NO;
        __block BOOL startedUpgrade = NO;
        __block NSInteger vpsStep = 0;
        NSDate *started = [NSDate date];
        NSTimer *monitor = [NSTimer timerWithTimeInterval:0.15 repeats:YES block:^(NSTimer *timer) {
            if (vpsStep == 0 && self.exitChoices[1].enabled && self.wpsSwitch.enabled) {
                [self selectExit:self.exitChoices[1]]; [self.wpsSwitch performClick:nil]; vpsStep = 1;
                if (self.wpsSwitch.state != NSControlStateValueOn || !self.wpsSwitch.enabled) vpsStep = -1;
            } else if (vpsStep == 1 && self.exitChoices[1].state == NSControlStateValueOn && self.wpsSwitch.state == NSControlStateValueOn) {
                [self selectExit:self.exitChoices[2]]; [self.wpsSwitch performClick:nil]; vpsStep = 2;
            } else if (vpsStep == 2 && self.exitChoices[2].state == NSControlStateValueOn && self.wpsSwitch.state == NSControlStateValueOff) {
                [self selectExit:self.exitChoices[0]]; vpsStep = 3;
            } else if (vpsStep == 3 && self.exitChoices[0].state == NSControlStateValueOn) {
                [self toggle:nil]; vpsStep = 4;
            } else if (vpsStep == 4 && [self.stateLabel.stringValue isEqual:@"Paused"]
                && [self.vpsItems filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"hidden == NO"]].count == 0) {
                [self toggle:nil]; vpsStep = 5;
            } else if (vpsStep == 5 && [self.stateLabel.stringValue isEqual:@"Running"]
                && [self.vpsItems filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"hidden == YES"]].count == 0) vpsStep = 6;
            NSString *title = self.upgradeItem.title;
            if (self.upgradeItem.hidden && !self.upgradeItem.enabled && self.toggleItem.enabled) sawChecking = YES;
            if (vpsStep == 6 && sawChecking && !startedUpgrade && !self.upgradeItem.hidden && [title hasPrefix:@"Upgrade to "] && self.upgradeItem.enabled && menuTitleFits(title)) {
                startedUpgrade = YES; [self upgrade:nil];
            }
            if (!self.upgradeItem.hidden && [title hasPrefix:@"Upgrading ("] && ![title isEqual:previousTitle] && menuTitleFits(title)) {
                previousTitle = [title copy]; changes++;
            }
            BOOL passed = vpsStep == 6 && sawChecking && startedUpgrade && changes >= 3 && !self.upgradeItem.enabled && !self.toggleItem.enabled
                && self.item.button.image.isTemplate && self.item.button.title.length == 0
                && [self.stateLabel.stringValue isEqual:@"Running"];
            if (passed || -[started timeIntervalSinceNow] > 8) {
                if (!passed) fprintf(stderr, "UI check failed: vps=%ld checking=%d upgrade=%d changes=%lu title=%s\n", (long)vpsStep, sawChecking, startedUpgrade, (unsigned long)changes, title.UTF8String);
                interfaceResult = passed ? 0 : 1;
                [timer invalidate]; [self.item.menu cancelTracking]; [NSApp stop:nil];
                NSEvent *wake = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
                [NSApp postEvent:wake atStart:NO];
            }
        }];
        [[NSRunLoop mainRunLoop] addTimer:monitor forMode:NSDefaultRunLoopMode];
        [[NSRunLoop mainRunLoop] addTimer:monitor forMode:NSEventTrackingRunLoopMode];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ [self.item.button performClick:nil]; });
    }
}
- (void)menuWillOpen:(NSMenu *)menu {
    if (!self.busy) { self.upgradeItem.hidden = YES; self.upgradeItem.enabled = NO; }
    @synchronized ([SbmMenu class]) { [actions addObject:@4]; }
}
- (void)sendAction:(int32_t)action {
    if (self.busy) return;
    self.busy = YES; self.toggleItem.enabled = NO; self.upgradeItem.enabled = NO; self.quitItem.enabled = NO;
    @synchronized ([SbmMenu class]) { [actions addObject:@(action)]; }
}
- (void)toggle:(id)sender { [self sendAction:self.loaded ? 2 : 1]; }
- (void)upgrade:(id)sender { [self sendAction:3]; }
- (void)selectExit:(NSMenuItem *)sender {
    if (!sender.enabled || sender.state == NSControlStateValueOn) return;
    for (NSMenuItem *choice in self.exitChoices) choice.enabled = NO;
    @synchronized ([SbmMenu class]) { [actions addObject:@(sender.tag)]; }
}
- (void)toggleWps:(id)sender {
    if (!self.wpsSwitch.enabled) return;
    self.wpsEnabled = !self.wpsEnabled;
    ++self.wpsRevision;
    self.wpsSwitch.state = self.wpsEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    @synchronized ([SbmMenu class]) { [actions addObject:self.wpsEnabled ? @13 : @14]; }
}
- (void)quit:(id)sender { if (!self.busy) [NSApp terminate:nil]; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (self.busy) return NSTerminateCancel;
    @synchronized ([SbmMenu class]) { closing = YES; }
    return NSTerminateNow;
}
- (void)receive:(NSDictionary *)message {
    NSString *kind = message[@"kind"];
    if ([kind isEqual:@"state"]) {
        NSInteger state = [message[@"status"] integerValue];
        for (NSMenuItem *item in self.vpsItems) item.hidden = state != 1;
        NSString *label = state == 1 ? @"Running" : state == 2 ? @"Paused" : @"Checking / waiting";
        self.item.button.toolTip = [NSString stringWithFormat:@"sbm — %@", label];
        self.stateItem.title = label;
        self.stateLabel.stringValue = label;
        self.stateDot.image = statusDot(state == 1 ? NSColor.systemGreenColor : state == 2 ? NSColor.systemRedColor : NSColor.systemYellowColor);
        NSString *version = message[@"version"];
        self.stateItem.view.accessibilityLabel = [NSString stringWithFormat:@"sbm, sing-box %@, %@", version, label];
        NSMutableAttributedString *title = [[NSMutableAttributedString alloc] initWithString:@"sbm"
            attributes:@{ NSFontAttributeName: [NSFont boldSystemFontOfSize:17], NSForegroundColorAttributeName: NSColor.labelColor }];
        [title appendAttributedString:[[NSAttributedString alloc] initWithString:[@"  " stringByAppendingString:version]
            attributes:@{ NSFontAttributeName: [NSFont systemFontOfSize:12], NSForegroundColorAttributeName: NSColor.secondaryLabelColor }]];
        self.titleLabel.attributedStringValue = title;
        self.titleLabel.toolTip = [@"sing-box " stringByAppendingString:version];
        self.busy = [message[@"busy"] boolValue]; self.loaded = [message[@"loaded"] boolValue];
        self.toggleItem.title = self.loaded ? @"Pause" : @"Start";
        self.toggleItem.enabled = !self.busy && [message[@"canStart"] boolValue];
        BOOL upgradeTitleChanged = ![self.upgradeItem.title isEqual:message[@"upgradeLabel"]];
        self.upgradeItem.title = message[@"upgradeLabel"];
        self.upgradeItem.hidden = self.upgradeItem.title.length == 0;
        self.upgradeItem.enabled = !self.busy && [message[@"canUpgrade"] boolValue];
        if (upgradeTitleChanged) {
            // AppKit keeps the original text-field width during menu tracking.
            // Reinsert the changed row so longer results/progress get laid out again.
            NSInteger index = [self.item.menu indexOfItem:self.upgradeItem];
            [self.item.menu removeItem:self.upgradeItem];
            [self.item.menu insertItem:self.upgradeItem atIndex:index];
        }
        self.quitItem.enabled = !self.busy;
    } else if ([kind isEqual:@"vps"]) {
        NSString *label = message[@"exitLabel"];
        if (@available(macOS 14.4, *)) self.exitItem.subtitle = label;
        else self.exitItem.title = [@"Exit — " stringByAppendingString:label];
        NSArray *modes = @[@"off", @"japan", @"usa_la"];
        for (NSInteger index = 0; index < self.exitChoices.count; index++) {
            NSMenuItem *choice = self.exitChoices[index];
            BOOL selected = [modes[index] isEqual:message[@"mode"]];
            choice.state = selected ? NSControlStateValueOn : NSControlStateValueOff;
            choice.enabled = [message[@"exitAvailable"] boolValue];
        }
        // A worker/status message predating a click must not move the switch back.
        if ([message[@"wpsRevision"] integerValue] >= self.wpsRevision) {
            self.wpsEnabled = [message[@"wpsEnabled"] boolValue];
            self.wpsSwitch.state = self.wpsEnabled ? NSControlStateValueOn : NSControlStateValueOff;
            self.wpsSwitch.enabled = [message[@"wpsAvailable"] boolValue];
            self.wpsSwitch.accessibilityHelp = message[@"wpsLabel"];
        }
    } else if ([kind isEqual:@"alert"]) {
        [NSApp activateIgnoringOtherApps:YES];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = [message[@"error"] boolValue] ? @"sbm couldn’t complete the operation" : @"sbm";
        alert.informativeText = message[@"message"];
        alert.alertStyle = [message[@"error"] boolValue] ? NSAlertStyleWarning : NSAlertStyleInformational;
        [alert runModal];
    } else if ([kind isEqual:@"authorize"]) {
        [NSApp activateIgnoringOtherApps:YES];
        NSString *worker = [[NSBundle mainBundle] pathForAuxiliaryExecutable:@"sbm-control"];
        if (!worker || ![[NSFileManager defaultManager] isExecutableFileAtPath:worker]) {
            finishAuthorization(3, @"The bundled control worker is missing. Rebuild or reinstall sbm.app."); return;
        }
        NSInteger action = [message[@"action"] integerValue];
        NSString *verb = action == 1 ? @"start" : action == 2 ? @"pause" : action == 3 ? @"upgrade" : nil;
        if (!verb) { finishAuthorization(3, @"Invalid action."); return; }
        NSString *command = [NSString stringWithFormat:@"%@ %@", shellQuote(worker), shellQuote(verb)];
        if (action == 3) command = [command stringByAppendingFormat:@" %@", shellQuote(message[@"directory"])];
        NSString *source = [NSString stringWithFormat:@"do shell script %@ with administrator privileges", scriptQuote(command)];
        dispatch_async(authorizationQueue, ^{
            @autoreleasepool {
                NSDictionary *error = nil;
                NSAppleScript *script = [[NSAppleScript alloc] initWithSource:source];
                NSAppleEventDescriptor *result = [script executeAndReturnError:&error];
                int32_t code = result ? 1 : [error[NSAppleScriptErrorNumber] integerValue] == -128 ? 2 : 3;
                finishAuthorization(code, error[NSAppleScriptErrorMessage] ?: @"");
            }
        });
    }
}
@end

int32_t sbm_run(uint8_t check) {
    @autoreleasepool {
        initializeBridge();
        interfaceTest = check != 0;
        NSApplication *application = [NSApplication sharedApplication];
        NSString *identifier = [[NSBundle mainBundle] bundleIdentifier];
        if (identifier && [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier].count > 1) return 0;
        [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
        @synchronized ([SbmMenu class]) { menu = [[SbmMenu alloc] init]; }
        application.delegate = menu;
        [application run];
        @synchronized ([SbmMenu class]) { closing = YES; }
        if (interfaceTest && interfaceResult == 0) fprintf(stdout, "PASS: native menu stays responsive and progress updates while open; VPS controls update, hide when paused and return when running.\n");
        return interfaceTest ? interfaceResult : 0;
    }
}

void sbm_render(int32_t status, const uint8_t *version, size_t versionLength, uint8_t busy, uint8_t loaded,
                uint8_t canStart, uint8_t canUpgrade, const uint8_t *upgrade, size_t upgradeLength) {
    @autoreleasepool {
        initializeBridge();
        NSDictionary *message = @{ @"kind": @"state", @"status": @(status), @"version": text(version, versionLength),
            @"busy": @(busy), @"loaded": @(loaded), @"canStart": @(canStart), @"canUpgrade": @(canUpgrade), @"upgradeLabel": text(upgrade, upgradeLength) };
        @synchronized ([SbmMenu class]) { lastModel = message; }
        onMain(message);
    }
}
void sbm_render_vps(const uint8_t *mode, size_t modeLength, const uint8_t *exitLabel, size_t exitLength,
                    uint8_t exitAvailable, uint8_t wpsEnabled, const uint8_t *wpsLabel, size_t wpsLength, uint8_t wpsAvailable, int32_t wpsRevision) {
    @autoreleasepool {
        onMain(@{ @"kind": @"vps", @"mode": text(mode, modeLength), @"exitLabel": text(exitLabel, exitLength),
            @"exitAvailable": @(exitAvailable), @"wpsEnabled": @(wpsEnabled), @"wpsLabel": text(wpsLabel, wpsLength), @"wpsAvailable": @(wpsAvailable), @"wpsRevision": @(wpsRevision) });
    }
}
int32_t sbm_action(void) {
    @autoreleasepool {
        initializeBridge();
        @synchronized ([SbmMenu class]) {
            if (!actions.count) return 0;
            int32_t action = actions.firstObject.intValue; [actions removeObjectAtIndex:0]; return action;
        }
    }
}
void sbm_authorize(int32_t action, const uint8_t *directory, size_t length) {
    @autoreleasepool { onMain(@{ @"kind": @"authorize", @"action": @(action), @"directory": text(directory, length) }); }
}
typedef void (*SbmAuthorizationCallback)(int32_t code, const uint8_t *message, size_t length, void *context);
void sbm_authorization_result(SbmAuthorizationCallback callback, void *context) {
    @autoreleasepool {
        int32_t code; NSString *message;
        @synchronized ([SbmMenu class]) {
            code = authorizationCode; message = authorizationMessage; authorizationCode = 0; authorizationMessage = nil;
        }
        if (code) { NSData *data = [message dataUsingEncoding:NSUTF8StringEncoding]; callback(code, data.bytes, data.length, context); }
    }
}
void sbm_alert(const uint8_t *message, size_t length, uint8_t error) {
    @autoreleasepool { onMain(@{ @"kind": @"alert", @"message": text(message, length), @"error": @(error) }); }
}
uint8_t sbm_closing(void) { @synchronized ([SbmMenu class]) { return closing ? 1 : 0; } }
uint8_t sbm_main_thread(void) { return [NSThread isMainThread] ? 1 : 0; }
