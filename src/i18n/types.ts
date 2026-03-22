/** Shape of every translation resource. All leaf values must be strings. */
export interface Translation {
    auth: {
        signInTitle: string
        email: string
        password: string
        signingIn: string
        signIn: string
        invalidCredentials: string
        noAccount: string
        register: string
        createAccountTitle: string
        creatingAccount: string
        alreadyHaveAccount: string
        registrationFailed: string
        welcomeBack: string
        openApp: string
        switchAccount: string
        forgotPassword: string
        forgotPasswordTitle: string
        forgotPasswordDesc: string
        sendResetLink: string
        sendingReset: string
        recoveryFailed: string
        checkEmailTitle: string
        checkEmailDesc: string
        backToSignIn: string
        resetPasswordTitle: string
        newPassword: string
        confirmPassword: string
        passwordMismatch: string
        resetPassword: string
        resettingPassword: string
        resetFailed: string
    }
    app: {
        loading: string
    }
    friends: {
        title: string
        tabAll: string
        tabPending: string
        tabAdd: string
        allFriends: string
        incoming: string
        noFriends: string
        noPending: string
        addFriendTitle: string
        addFriendDesc: string
        usernamePlaceholder: string
        sendRequest: string
        requestSent: string
        requestFailed: string
        unfriended: string
        unfriendFailed: string
        dmFailed: string
        accepted: string
        acceptFailed: string
        declined: string
        declineFailed: string
        doNotDisturb: string
        message: string
        removeFriend: string
        accept: string
        decline: string
    }
    channel: {
        searchMessages: string
        closeSearch: string
        showMemberList: string
        hideMemberList: string
        connected: string
        connected_plural: string
        clickToJoin: string
        joinVoice: string
        you: string
        searchResults: string
        membersPanel: string
    }
    threads: {
        title: string
        showThreadList: string
        hideThreadList: string
        emptyTitle: string
        emptyDescription: string
        closedBadge: string
        previewEmpty: string
        previewEmbeds: string
        previewAttachments: string
        openThread: string
        createThread: string
        threadFallback: string
        missingThread: string
        createTitle: string
        createDescription: string
        createContentRequired: string
        createFailed: string
        threadName: string
        threadNamePlaceholder: string
        starterMessage: string
        starterMessagePlaceholder: string
        composeDescription: string
        backToList: string
        editThread: string
        deleteThread: string
        editTitle: string
        editDescription: string
        topic: string
        topicPlaceholder: string
        closeThread: string
        reopenThread: string
        updateFailed: string
        deleteTitle: string
        deleteDescription: string
        deleteFailed: string
        closedComposer: string
        noSendPermission: string
        threadCreatedStarted: string
        threadCreatedSeeAll: string
        threadCreatedThreadsLink: string
    }
    settings: {
        userSettings: string
        myAccount: string
        appearance: string
        voiceVideo: string
        language: string
        dangerZone: string
        username: string
        discriminator: string
        userId: string
        save: string
        copy: string
        profileUpdated: string
        profileFailed: string
        changeAvatar: string
        avatarUpdated: string
        avatarFailed: string
        bio: string
        bioPlaceholder: string
        bannerColor: string
        panelColor: string
        profileCustomization: string
        profilePreview: string
        chatFontScale: string
        messageSpacing: string
        preview: string
        compact: string
        comfortable: string
        spacious: string
        saveChanges: string
        saving: string
        appearanceSaved: string
        appearanceFailed: string
        inputDevice: string
        outputDevice: string
        inputVolume: string
        outputVolume: string
        defaultDevice: string
        audioProcessing: string
        echoCancellation: string
        echoCancellationDesc: string
        noiseSuppression: string
        noiseSuppressionDesc: string
        noiseSuppressionEnabled: string
        denoiserDefault: string
        denoiserRnnoise: string
        denoiserSpeex: string
        autoGainControl: string
        autoGainControlDesc: string
        inputMode: string
        voiceActivity: string
        pushToTalk: string
        sensitivityThreshold: string
        sensitive: string
        aggressive: string
        shortcut: string
        pressAnyKey: string
        clickToSetKey: string
        videoDevice: string
        cameraPreview: string
        testCamera: string
        stopPreview: string
        resetToDefaults: string
        voiceSaved: string
        voiceFailed: string
        selectLanguage: string
        selectLanguageDesc: string
        languageSaved: string
        languageFailed: string
        dangerDesc: string
        logOut: string
        logOutDesc: string
        deleteAccount: string
        deleteAccountDesc: string
        delete: string
    }
    // User area (bottom-left user controls)
    userArea: {
        signedInAs: string
        setCustomStatus: string
        clearCustomStatus: string
        setStatus: string
        settings: string
        customStatusUpdated: string
        customStatusCleared: string
        customStatusFailed: string
        customStatusDialogTitle: string
        customStatusPlaceholder: string
        clearStatus: string
        cancel: string
        save: string
    }
    // DM sidebar
    dm: {
        title: string
        friends: string
        directMessages: string
        closeDmFailed: string
        closeConversation: string
        groupDm: string
        allServers: string
        servers: string
    }
    // Modals
    modals: {
        createServer: string
        serverName: string
        serverNamePlaceholder: string
        createCategory: string
        categoryName: string
        categoryNamePlaceholder: string
        createCategoryFailed: string
        createChannel: string
        channelType: string
        channelName: string
        channelNamePlaceholderText: string
        channelNamePlaceholderVoice: string
        textChannel: string
        voiceChannel: string
        createChannelFailed: string
        invitePeople: string
        noActiveInvites: string
        createNewInvite: string
        createInviteFailed: string
        deleteInviteFailed: string
        inviteCopied: string
        copyLink: string
        deleteInvite: string
        joinServer: string
        joinServerDesc: string
        inviteLinkOrCode: string
        invitePlaceholder: string
        joinServerFailed: string
        deleteChannelTitle: string
        deleteMessageTitle: string
        deleteWarning: string
        cancel: string
        create: string
        join: string
        delete: string
    }
    // Chat
    chat: {
        welcomeChannel: string
        welcomeDm: string
        welcomeChannelDesc: string
        welcomeDmDesc: string
        newMessages: string
        jumpToBottom: string
        jumpToPresent: string
        fileExceedsLimit: string
        maxFilesError: string
        sendFailed: string
        send: string
        messagePlaceholder: string
        dropFiles: string
        channels: string
        membersAndRoles: string
        role: string
        typingOne: string
        typingTwo: string
        typingSeveral: string
        messagesSkippedApprox: string
        loadingOlderMessages: string
        loadingNewerMessages: string
        moreOlderMessages: string
        moreNewerMessages: string
        viewingOlderMessages: string
        retryLoad: string
        olderMessagesFailed: string
        newerMessagesFailed: string
    }
    search: {
        link: string
        image: string
        video: string
        file: string
        jump: string
        attachment: string
        searchTitle: string
        closeSearch: string
        searchMessages: string
        filterByAttachment: string
        filterByAuthor: string
        typeMemberName: string
        filterByChannel: string
        typeChannelName: string
        from: string
        has: string
        in: string
        noResults: string
        tryDifferent: string
        useFiltersDesc: string
        resultCount: string
        resultCountPlural: string
        onThisPage: string
        pageOf: string
        prev: string
        next: string
    }
    memberList: {
        online: string
        offline: string
        loading: string
        viewProfile: string
        roles: string
        message: string
        copyUserId: string
        roleAssigned: string
        roleRemoved: string
        roleAssignFailed: string
        roleRemoveFailed: string
        dmFailed: string
    }
    messageItem: {
        copyText: string
        copyMessageId: string
        reply: string
        replyingTo: string
        cancelReply: string
        replyUnavailable: string
        replyEmbeds: string
        replyAttachments: string
        editMessage: string
        deleteMessage: string
        messageUser: string
        deleteTitle: string
        deleteDesc: string
        editFailed: string
        deleteFailed: string
        sending: string
        failedToSend: string
        retrySend: string
        suppressEmbedsTitle: string
        suppressEmbedsDesc: string
        suppressEmbedsConfirm: string
        enterTo: string
        save: string
        escTo: string
        cancel: string
        edited: string
    }
    joinMessages: string[]
    serverSidebar: {
        editFolder: string
        dissolveFolder: string
        serverSettings: string
        copyServerId: string
        newFolder: string
        addToFolder: string
        leaveServer: string
        leaveServerConfirm: string
        removeFromFolder: string
        createFolderTitle: string
        editFolderTitle: string
        createFolderDesc: string
        editFolderDesc: string
        folderName: string
        folderNameDefault: string
    }
    channelSidebar: {
        serverSettings: string
        invitePeople: string
        newChannel: string
        newCategory: string
        copyServerId: string
        editCategory: string
        addChannel: string
        copyCategoryId: string
        deleteCategory: string
        viewChannel: string
        editChannel: string
        copyChannelId: string
        deleteChannel: string
        renameFailed: string
        joinVoiceFailed: string
        reorderFailed: string
        deleteCategoryTitle: string
        deleteChannelTitle: string
        deleteCategoryDesc: string
        deleteChannelDesc: string
        volume: string
        allServers: string
    }
    voicePanel: {
        connecting: string
        routing: string
        connected: string
        disconnected: string
        ping: string
        mute: string
        unmute: string
        deafen: string
        undeafen: string
        disconnect: string
        cameraOn: string
        cameraOff: string
    }
    userProfile: {
        memberSince: string
        roles: string
        rolesWithCount: string
        noRoles: string
        noServerRoles: string
        sendMessage: string
        addFriend: string
        bio: string
    }
    common: {
        save: string
        cancel: string
        close: string
        confirm: string
        delete: string
        create: string
        edit: string
        copy: string
        search: string
        loading: string
        error: string
        unknown: string
        todayAt: string
        yesterdayAt: string
        done: string
    }
    serverSettings: {
        title: string
        navOverview: string; navMembers: string; navRoles: string; navInvites: string; navEmoji: string; navBans: string; navDanger: string
        overviewTitle: string; changeIcon: string; publicServer: string; privateServer: string
        serverNameLabel: string; serverNamePlaceholder: string; publicServerLabel: string; publicServerDesc: string; serverIdLabel: string
        copy: string; copied: string; saving: string; saveChanges: string; overviewSaved: string; overviewFailed: string
        iconUploaded: string; iconFailed: string; iconFileFailed: string
        membersTitle: string; filterOf: string; filterPlaceholder: string; joined: string; kickMember: string; banMember: string
        kickSuccess: string; kickFailed: string; banSuccess: string; banFailed: string; noMembersMatch: string; noMembers: string
        bansTitle: string; noBans: string; banReason: string; unbanning: string; unban: string; unbanSuccess: string; unbanFailed: string
        rolesTitle: string; createRole: string; roleNamePlaceholder: string; everyoneRole: string; everyoneBadge: string
        backToRoles: string; editRole: string; everyoneDesc: string; roleEditDesc: string; deleteRole: string
        colorLabel: string; roleColorTitle: string; roleNameLabel: string
        adminWarningTitle: string; adminWarningDesc: string
        noCustomRoles: string; selectRoleHint: string; roleIdLabel: string
        roleSaved: string; roleFailed: string; roleCreated: string; roleCreateFailed: string; roleDeleted: string; roleDeleteFailed: string; roleReorderFailed: string
        invitesTitle: string; inviteOneHour: string; inviteOneDay: string; inviteSevenDays: string; inviteThirtyDays: string; inviteNeverExpires: string
        inviteCreatedAt: string; inviteExpired: string; inviteExpires: string; inviteNever: string
        copyInviteLink: string; revokeInvite: string; inviteCopied: string; noActiveInvites: string; inviteRevokeFailed: string
        emojiTitle: string; emojiDesc: string; uploadEmoji: string; emojiLimits: string
        emojiNameLabel: string; emojiNamePlaceholder: string; emojiNameHint: string; emojiFileLabel: string
        uploading: string; upload: string; emojiUploaded: string; emojiUploadFailed: string; emojiNameSaved: string; emojiNameSaveFailed: string; emojiDeleted: string; emojiDeleteFailed: string
        deleteServer: string; deleteServerDesc: string; deleteServerConfirm: string; deleteServerFailed: string; deleteServerNameMismatch: string
        permCategoryGeneral: string; permCategoryMembership: string; permCategoryText: string; permCategoryVoice: string
        permAdministrator: string; permAdministratorDesc: string
        permManageServer: string; permManageServerDesc: string
        permManageRoles: string; permManageRolesDesc: string
        permManageChannels: string; permManageChannelsDesc: string
        permViewAuditLog: string; permViewAuditLogDesc: string
        permCreateInvites: string; permCreateInvitesDesc: string
        permKickMembers: string; permKickMembersDesc: string
        permBanMembers: string; permBanMembersDesc: string
        permTimeoutMembers: string; permTimeoutMembersDesc: string
        permManageNicknames: string; permManageNicknamesDesc: string
        permChangeNickname: string; permChangeNicknameDesc: string
        permViewChannels: string; permViewChannelsDesc: string
        permReadHistory: string; permReadHistoryDesc: string
        permSendMessages: string; permSendMessagesDesc: string
        permAttachFiles: string; permAttachFilesDesc: string
        permAddReactions: string; permAddReactionsDesc: string
        permMentionRoles: string; permMentionRolesDesc: string
        permManageMessages: string; permManageMessagesDesc: string
        permSendInThreads: string; permSendInThreadsDesc: string
        permCreateThreads: string; permCreateThreadsDesc: string
        permManageThreads: string; permManageThreadsDesc: string
        permConnect: string; permConnectDesc: string
        permSpeak: string; permSpeakDesc: string
        permVideo: string; permVideoDesc: string
        permMuteMembers: string; permMuteMembersDesc: string
        permDeafenMembers: string; permDeafenMembersDesc: string
        permMoveMembers: string; permMoveMembersDesc: string
    }
    // ── App Settings modal (Electron title-bar ⚙ button) ─────────────────────
    appSettings: {
        title: string
        tabConnection: string
        tabAppearance: string
        tabInfo: string
        apiBaseUrl: string
        wsUrl: string
        connectionReloadHint: string
        resetToDefaults: string
        saveAndReload: string
        chatBackground: string
        chatBackgroundDesc: string
        changeImage: string
        chooseImage: string
        appVersion: string
        electronVersion: string
        chromiumVersion: string
        nodeVersion: string
        platform: string
        versionInfoUnavailable: string
        checkForUpdates: string
        checking: string
        upToDate: string
        checkFailed: string
        updateReady: string
        restartAndInstall: string
    }
}
