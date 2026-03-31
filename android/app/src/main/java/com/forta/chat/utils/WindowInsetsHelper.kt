package com.forta.chat.utils

import android.app.Activity
import android.graphics.Color
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

object WindowInsetsHelper {

    /**
     * Enable edge-to-edge mode for an Activity, then apply real system bar
     * insets as padding to the designated top / bottom views.
     */
    fun setupEdgeToEdge(
        activity: Activity,
        topView: View? = null,
        bottomView: View? = null,
        onInsets: ((top: Int, bottom: Int, left: Int, right: Int) -> Unit)? = null
    ) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)

        activity.window.statusBarColor = Color.TRANSPARENT
        activity.window.navigationBarColor = Color.TRANSPARENT

        val rootView = activity.findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())

            topView?.setPadding(
                topView.paddingLeft,
                systemBars.top,
                topView.paddingRight,
                topView.paddingBottom
            )

            bottomView?.setPadding(
                bottomView.paddingLeft,
                bottomView.paddingTop,
                bottomView.paddingRight,
                systemBars.bottom
            )

            onInsets?.invoke(systemBars.top, systemBars.bottom, systemBars.left, systemBars.right)

            insets
        }
    }
}
